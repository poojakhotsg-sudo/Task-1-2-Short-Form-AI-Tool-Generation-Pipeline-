import { chromium, devices } from 'playwright';
import { mkdtemp, readFile, rename, rm, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { preparePage, FIND_BLOCKS_JS } from './pageInteraction.js';
import { CURSOR_JS, recordShot, recordMotion, saveHero } from './recordShot.js';
import { pickSections, libraryName, type PageBlock } from './pageSections.js';
import { SITE_DATA_JS, type SiteData, type RawSiteData } from './siteData.js';
import { cutClipToVertical, getClipDurationSeconds } from '../lib/ffmpeg.js';
import { checkClip, isStatic, shouldKeepOriginalTake, type QaMetrics } from './qa/checkClip.js';

interface BlocksInfo {
  blocks: PageBlock[];
  height: number;
  vh: number;
}

// PIPE-02's "grab" stage, ported from pipeline/grabber.py's grab() /
// _record_library() "pass 1" (lines 1319-1422 of the source). Faithful
// port of the section-clip recording: context-wide video recording,
// scroll/hover/drift per section, ffmpeg-cut into 1080x1920 clips.
//
// Pass 2 (grabber.py lines 1424-1468) — the static-clip motion retry —
// is now ported too, using checkClip() (worker/src/services/qa/checkClip.ts,
// PIPE-06) as the QA signal that decides which clips need it. See
// retryStaticClips() below for the faithful "re-record, re-check, keep
// whichever take is less static" logic.
//
// NOT ported in this pass — flagged, not silently dropped:
//
// 1. Network/embedded video downloads (download_videos/download_embeds,
//    yt-dlp-based) — EXTRACT-03-shaped work, a different kind of task
//    than section-clip recording, not attempted here.
// 2. The shot_list-aware per-shot recording path (_find_shot_sections +
//    clip_name()-named clips) — grabber.py's grab() takes this path only
//    when shot_list.json already exists at grab time. In this pipeline's
//    dependency graph (stageGraph.ts), grab always runs before script,
//    so shot_list.json never exists yet when this runs — that branch is
//    dead code for us by construction, not something worth porting.
// 3. Cookie-click / chat-widget / bot-check / page-load handling lives in
//    pageInteraction.ts, ported there — not re-described here.

const VIEWPORT = { width: 390, height: 844 };
const RECORD_SECONDS = 9.0; // grab()'s default, already within [MIN_CLIP_S, MAX_CLIP_S] = [8, 10]
const MAX_SECTIONS = 8;

export interface RecordedClip {
  file: string; // e.g. "clip01_hero.mp4" — caller decides the storage prefix
  content: Buffer;
  section: string;
  text: string;
  y: number;
  h: number;
  hasVideo: boolean;
  seconds: number | null;
  qa: 'pass' | 'fail';
  qaReasons: string[];
  qaMetrics: QaMetrics;
  retried: boolean;
}

export interface CaptureSiteResult {
  heroPng: Buffer;
  siteData: SiteData;
  clips: RecordedClip[];
  clipErrors: { section: string; error: string }[];
  clipsRecorded: number;
}

export async function captureSite(url: string, opts: { headed?: boolean } = {}): Promise<CaptureSiteResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'capture-site-'));
  const browser = await chromium.launch({ headless: !opts.headed });

  try {
    const device = { ...devices['iPhone 14'], viewport: VIEWPORT, isMobile: true, hasTouch: true };
    const context = await browser.newContext({
      ...device,
      recordVideo: { dir: tempDir, size: VIEWPORT },
    });
    context.setDefaultTimeout(20000);
    const page = await context.newPage();

    const t0 = Date.now();
    let siteDataRaw: RawSiteData;
    let heroPng: Buffer;
    let webmPath: string | null = null;
    const picks: PageBlock[] = [];
    const segments: ([number, number] | null)[] = [];

    try {
      await preparePage(page, url);

      const initialInfo = await page.evaluate<BlocksInfo>(FIND_BLOCKS_JS);
      siteDataRaw = await page.evaluate<RawSiteData>(SITE_DATA_JS);
      heroPng = await saveHero(page, siteDataRaw.hero_bottom, initialInfo.vh);

      await page.evaluate(CURSOR_JS);
      await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 3);
      await page.waitForTimeout(800);

      const info = await page.evaluate<BlocksInfo>(FIND_BLOCKS_JS);
      const blocks: PageBlock[] =
        info.blocks.length > 0 ? info.blocks : [{ y: 0, h: info.vh, text: '', title: 'Top of page', video: false }];
      const maxY = Math.max(0, info.height - info.vh);
      const sections = pickSections(blocks, MAX_SECTIONS);

      for (const block of sections) {
        picks.push(block);
        try {
          segments.push(await recordShot(page, block, maxY, info.vh, RECORD_SECONDS, t0));
        } catch {
          segments.push(null);
        }
      }
    } finally {
      // Always close, even on failure mid-recording — matches
      // grabber.py's finally-closes-the-session behavior, so whatever
      // sections did succeed before an error can still be cut below.
      const video = page.video();
      await context.close();
      webmPath = video ? await video.path() : null;
    }

    const working: WorkingClip[] = [];
    const clipErrors: { section: string; error: string }[] = [];

    for (let n = 1; n <= picks.length; n++) {
      const block = picks[n - 1];
      const segment = segments[n - 1];
      const section = block.title || '';

      if (!segment) {
        clipErrors.push({ section, error: 'recording failed' });
        continue;
      }
      if (!webmPath) {
        clipErrors.push({ section, error: 'no session recording was produced' });
        continue;
      }

      const filename = libraryName(n, block.title);
      const outPath = join(tempDir, filename);
      try {
        await cutClipToVertical(webmPath, segment[0], segment[1], outPath, RECORD_SECONDS);
      } catch (err) {
        clipErrors.push({ section, error: `ffmpeg cut failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      let seconds: number | null = null;
      try {
        seconds = await getClipDurationSeconds(outPath);
      } catch {
        seconds = null; // duration probe failing doesn't invalidate the clip itself
      }

      const { metrics, reasons } = await checkClip(outPath);
      working.push({ block, filename, outPath, section, seconds, metrics, reasons, retried: false });
    }

    // Pass 2 (grabber.py lines 1424-1468): one retry with more motion for
    // clips QA found "mostly static." A fresh session, since the first
    // one's video recording is already finalized and cut.
    const stillStatic = working.filter((c) => isStatic(c.reasons));
    if (stillStatic.length > 0) {
      await retryStaticClips(browser, url, opts, tempDir, t0, stillStatic);
    }

    const clips: RecordedClip[] = await Promise.all(
      working.map(async (c) => ({
        file: c.filename,
        content: await readFile(c.outPath),
        section: c.section,
        text: c.block.text.slice(0, 800),
        y: c.block.y,
        h: c.block.h,
        hasVideo: c.block.video,
        seconds: c.seconds,
        qa: c.reasons.length > 0 ? 'fail' : 'pass',
        qaReasons: c.reasons,
        qaMetrics: c.metrics,
        retried: c.retried,
      }))
    );

    const { hero_bottom, ...siteData } = siteDataRaw;
    void hero_bottom;

    return { heroPng, siteData, clips, clipErrors, clipsRecorded: clips.length };
  } finally {
    await browser.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

interface WorkingClip {
  block: PageBlock;
  filename: string;
  outPath: string;
  section: string;
  seconds: number | null;
  metrics: QaMetrics;
  reasons: string[];
  retried: boolean;
}

// grabber.py's "pass 2": re-open a session, re-prepare the page, and for
// each still-static clip, record_motion() instead of record_shot(), cut
// the retry into a separate temp file, re-check it, and keep whichever
// take is actually less static — mirroring the source's exact
// keep-vs-replace comparison (lines 1458-1467), not just "always use the
// retry."
async function retryStaticClips(
  browser: import('playwright').Browser,
  url: string,
  opts: { headed?: boolean },
  tempDir: string,
  t0: number,
  staticClips: WorkingClip[]
): Promise<void> {
  const device = { ...devices['iPhone 14'], viewport: VIEWPORT, isMobile: true, hasTouch: true };
  const context = await browser.newContext({ ...device, recordVideo: { dir: tempDir, size: VIEWPORT } });
  context.setDefaultTimeout(20000);
  const page = await context.newPage();
  const retryT0 = Date.now();

  let webmPath: string | null = null;
  const retrySegments: ([number, number, number] | null)[] = [];

  try {
    await preparePage(page, url);
    await page.evaluate(CURSOR_JS);
    const info = await page.evaluate<BlocksInfo>(FIND_BLOCKS_JS);
    const maxY = Math.max(0, info.height - info.vh);
    const byTitle = new Map(info.blocks.map((b) => [b.title, b]));

    for (const clip of staticClips) {
      const block = byTitle.get(clip.section) ?? { y: clip.block.y, h: clip.block.h, text: '', title: '', video: false };
      try {
        retrySegments.push(await recordMotion(page, block, maxY, info.vh, RECORD_SECONDS, retryT0));
      } catch {
        retrySegments.push(null);
      }
    }
  } finally {
    const video = page.video();
    await context.close();
    webmPath = video ? await video.path() : null;
  }

  for (let i = 0; i < staticClips.length; i++) {
    const clip = staticClips[i];
    const segment = retrySegments[i];
    clip.retried = true;
    if (!segment || !webmPath) continue;

    const retryPath = join(tempDir, clip.filename.replace(/\.mp4$/, '_retry.mp4'));
    try {
      await cutClipToVertical(webmPath, segment[0], segment[1], retryPath, RECORD_SECONDS);
    } catch {
      continue; // keep the original take — matches the source's "retry cut failed, log and move on"
    }

    const { metrics: retryMetrics, reasons: retryReasons } = await checkClip(retryPath);

    if (shouldKeepOriginalTake(clip.metrics.motion, retryReasons, retryMetrics.motion)) {
      // No better: keep the first take, still a fail. Matches the
      // source exactly — a retry that isn't actually less static than
      // the original isn't worth swapping in.
      await unlink(retryPath).catch(() => {});
      clip.reasons = [...clip.reasons, 'still static after a retry'];
    } else {
      // os.replace(tmp_out, out) — swap the retry in as the clip's file,
      // not a delete-then-re-cut.
      await rename(retryPath, clip.outPath);
      clip.metrics = retryMetrics;
      clip.reasons = isStatic(retryReasons) ? [...retryReasons, 'still static after a retry'] : retryReasons;
      try {
        clip.seconds = await getClipDurationSeconds(clip.outPath); // same probe pass-1 used, for consistency
      } catch {
        clip.seconds = retryMetrics.seconds;
      }
    }
  }
}
