import { chromium } from 'playwright';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { EMBED_REC_VIEWPORT, EMBED_REC_SECONDS, PLAY_VIDEOS_JS } from './constants.js';
import { downloadViaYtdlp, type HlsDownloadResult, type HlsDownloadError } from './hls.js';
import { encodeSegment } from './convert.js';
import { probeVideoFull } from '../../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);

// extract_assets.py's embed_url()/record_embed(), and download_all()'s
// embed loop (lines 1578-1598) that ties them together with ytdlp():
// for every iframe candidate EMBED_RE matched, try yt-dlp against a
// normalized URL first; if that fails, fall back to actually playing
// the embed muted in a fresh headless browser and recording it.

// extract_assets.py's embed_url() (lines 941-954): normalize an iframe
// src to something yt-dlp understands (YouTube/Vimeo/Loom embed URLs ->
// their canonical watch/share URLs). Anything else is passed through
// unchanged — yt-dlp has broad native-site support beyond this list.
export function embedUrl(u: string): string {
  const yt = u.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/);
  if (yt) return `https://www.youtube.com/watch?v=${yt[1]}`;

  const vimeo = u.match(/player\.vimeo\.com\/video\/(\d+)/);
  if (vimeo) {
    const h = u.match(/[?&]h=(\w+)/);
    return `https://vimeo.com/${vimeo[1]}` + (h ? `/${h[1]}` : '');
  }

  const loom = u.match(/loom\.com\/embed\/(\w+)/);
  if (loom) return `https://www.loom.com/share/${loom[1]}`;

  return u;
}

// extract_assets.py's ytdlp() call in download_all() (line 1585) also
// reads a `.title` file ytdlp() itself writes from yt-dlp's returned
// info dict. Shelling out to the CLI (not the Python library) means
// there's no info dict to read — a second, lightweight `--print title`
// call gets the same value, same pattern as siteText.ts's embedInfo().
export async function fetchYtdlpTitle(url: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('yt-dlp', ['--no-warnings', '--skip-download', '--print', '%(title)s', url], {
      timeout: 20000,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

export interface EmbedResult {
  content: Buffer;
  ext: string;
  kind: 'embed' | 'embed_recording';
  title: string;
}

export interface EmbedError {
  error: string;
}

// extract_assets.py's record_embed() (lines 956-1001): play the embed
// muted at 1280x720 and record EMBED_REC_SECONDS=8s, in a fresh headless
// browser (own launch, not the main scraping session — the source does
// the same via its own launch_or_connect() call). Corrects for
// Playwright's video-timestamp-vs-wall-clock drift with the same `k`
// factor the source computes (real ffprobe duration ÷ measured wall-clock
// duration), same as record_scroll()'s identical correction elsewhere in
// the source (record_scroll() itself isn't ported — see extractMedia.ts).
async function recordEmbed(url: string, referer: string, headed: boolean): Promise<{ content: Buffer } | { error: string }> {
  const recDir = await mkdtemp(join(tmpdir(), 'embed-rec-'));
  let browser: import('playwright').Browser | null = null;

  try {
    browser = await chromium.launch({ headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] });
    const context = await browser.newContext({
      viewport: EMBED_REC_VIEWPORT,
      recordVideo: { dir: recDir, size: EMBED_REC_VIEWPORT },
      extraHTTPHeaders: { Referer: referer },
    });
    const page = await context.newPage();
    const t0 = Date.now();

    const playUrl = url + (url.includes('?') ? '&' : '?') + 'autoplay=1&mute=1&muted=1';
    let status: number | null = null;
    try {
      const resp = await page.goto(playUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      status = resp ? resp.status() : null;
    } catch (err) {
      await context.close();
      return { error: err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'embed page failed to load' };
    }
    if (status !== null && status >= 400) {
      await context.close();
      return { error: `embed page returned ${status}` };
    }

    await page.waitForTimeout(2500);
    try {
      await page.mouse.click(EMBED_REC_VIEWPORT.width / 2, EMBED_REC_VIEWPORT.height / 2);
    } catch {
      // matches the source's bare except — a click isn't essential, just helps autoplay on some embeds
    }
    await page.evaluate(PLAY_VIDEOS_JS);
    await page.waitForTimeout(1000);

    const start = (Date.now() - t0) / 1000;
    await page.waitForTimeout(EMBED_REC_SECONDS * 1000);
    const end = (Date.now() - t0) / 1000;

    const video = page.video();
    const tClose = (Date.now() - t0) / 1000;
    await context.close();
    const rawPath = video ? await video.path() : null;
    if (!rawPath) return { error: 'no embed recording was produced' };

    const probedDuration = (await probeVideoFull(rawPath)).durationSeconds;
    const k = (probedDuration || tClose) / Math.max(tClose, 0.1);

    const outPath = join(recDir, 'embed_rec.mp4');
    const ok = await encodeSegment(rawPath, outPath, start * k, (end - start) * k, null);
    if (!ok) return { error: 'could not encode the embed recording' };

    return { content: await readFile(outPath) };
  } catch (err) {
    return { error: err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'embed recording failed' };
  } finally {
    if (browser) await browser.close();
    await rm(recDir, { recursive: true, force: true });
  }
}

export interface EmbedOutcome {
  url: string;
  resolved: string;
  result: string; // "downloaded" | "recorded playing" | "failed: <ytdlp error>; recording: <record error>"
  staged: EmbedResult | null;
}

// extract_assets.py's per-embed logic inside download_all() (lines
// 1579-1598): yt-dlp first, record_embed() as the fallback.
export async function downloadOrRecordEmbed(
  originalUrl: string,
  referer: string,
  tempDir: string,
  stem: string,
  opts: { headed?: boolean } = {}
): Promise<EmbedOutcome> {
  const resolved = embedUrl(originalUrl);

  const ytdlpResult: HlsDownloadResult | HlsDownloadError = await downloadViaYtdlp(resolved, tempDir, stem, referer);
  if ('content' in ytdlpResult) {
    const title = await fetchYtdlpTitle(resolved);
    return {
      url: originalUrl,
      resolved,
      result: 'downloaded',
      staged: { content: ytdlpResult.content, ext: ytdlpResult.ext, kind: 'embed', title },
    };
  }

  const recordResult = await recordEmbed(resolved, referer, opts.headed ?? false);
  if ('content' in recordResult) {
    return {
      url: originalUrl,
      resolved,
      result: 'recorded playing',
      staged: { content: recordResult.content, ext: '.mp4', kind: 'embed_recording', title: '' },
    };
  }

  return {
    url: originalUrl,
    resolved,
    result: `failed: ${ytdlpResult.error}; recording: ${recordResult.error}`,
    staged: null,
  };
}
