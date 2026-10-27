import { chromium, devices } from 'playwright';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  ASSET_DEVICE, ASSET_VIEWPORT, NAV_TIMEOUT_MS, BACKOFF_MS, EMBED_RE, HEADINGS_JS, PROMOTE_LAZY_JS, SCROLL_NESTED_JS,
  MIN_STILL_BYTES,
} from './extractMedia/constants.js';
import { collect, scrollPage, clickReveals, dismissConsent, recordMedia, networkCounts, type FoundMap, type NetworkEntry, type MediaRequestLog } from './extractMedia/collect.js';
import { sectionFor, isVideoUrl, dedupeCandidates, originalName, FAVICON_RE, TRACKING_RE, type Candidate, type HeadingMark } from './extractMedia/pure.js';
import { downloadAsset } from './extractMedia/download.js';
import { inspectAsset, type InspectKind, type InspectFacts } from './extractMedia/inspect.js';
import { toMp4Video, animatedGifToMp4, animatedToMp4 } from './extractMedia/convert.js';
import { normalizeVideoFile } from './normalizeMedia.js';
import { BOT_RE, hammingDistance, similarShape } from './extractMedia/pure.js';
import { computeDHash, middleFrameSeconds } from './extractMedia/phash.js';
import { downloadOrRecordEmbed, embedUrl, type EmbedOutcome } from './extractMedia/embed.js';

const NEAR_DUP = 4; // extract_assets.py's NEAR_DUP (line 80): phash distance threshold

// PIPE-? / EXTRACT-01..07, ported from extract_assets.py's extract()/
// _extract() (lines 1415-1696). This is a ~1900-line, multi-concern
// CLI tool; porting every concern faithfully in one pass isn't
// realistic, so this is explicitly a first installment, scoped after
// asking the user to confirm "everything, understood as multi-turn."
//
// What IS ported in this pass (faithfully, not approximated):
// - Page load with retry/backoff + a final headed attempt, bot-check
//   text detection (open_page()).
// - Consent-banner dismissal, DOM asset collection (images/videos/
//   iframes/SVGs/shadow-roots), scroll-driven lazy-load triggering,
//   click-reveals (tabs/carousels/show-more), and network-response
//   interception for images/video (collect()/scroll_page()/
//   click_reveals()/record_media() — see extractMedia/collect.ts).
// - Candidate dedup by asset identity (dedupe_candidates()).
// - Plain HTTP downloads with cookies/referer/UA, including data: URLs
//   and HLS (.m3u8) media via an ffmpeg-remux-or-yt-dlp fallback
//   (download(), download_hls(), ytdlp() — see download.ts/hls.ts).
// - Format inspection via ffprobe (inspect(), re-based off PIL — see
//   inspect.ts), video-to-mp4 conversion (to_mp4_video()), and the full
//   animated_to_mp4() — GIF directly, and animated WebP/APNG/AVIF via
//   ffmpeg's own decoders instead of PIL (see convert.ts's file-level
//   comment on animatedToMp4()) — plus reuse of this worker's own
//   normalize_media logic for the final h264/yuv420p pass.
// - sha256-based AND perceptual-hash (phash) near-duplicate dedup,
//   category placement, and manifest/report construction (finish()/
//   place()), adapted from filesystem moves to in-memory buffers +
//   storage keys this route uploads. The phash side is NOT bit-for-bit
//   the source's algorithm — see extractMedia/phash.ts's file-level
//   comment for the one real, documented divergence (dHash instead of
//   imagehash's DCT-based phash, same 64-bit/Hamming-distance shape and
//   NEAR_DUP=4 threshold).
// - iframe/embed candidates (YouTube/Vimeo/Loom/Wistia/etc. detected via
//   EMBED_RE): yt-dlp first (embed_url()/ytdlp()), falling back to
//   actually playing the embed muted in a fresh headless browser and
//   recording 8s of it (record_embed()) — see embed.ts.
//
// What is NOT ported in this pass — flagged, not silently dropped:
// 1. record_scroll() — the mobile scroll-through video + per-section
//    clips that give this task its "scroll" folder in the source. A
//    separate, substantial piece (bot-check-bypass retry ladder with a
//    saved-auth-cookie fallback, custom eased-scroll pacing, phash-
//    deduped section clips).
const VIEWPORT = ASSET_VIEWPORT;

export interface ExtractMediaOptions {
  headed?: boolean;
}

export interface ManifestEntry {
  category: 'videos_gifs' | 'images';
  type: string;
  filename: string;
  path: string;
  mp4: string | null;
  sourceUrl: string;
  originalFilename: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  sizeBytes: number;
  pageOrder: number;
  pageY: number | null;
  section: string;
}

export interface ExtractMediaFile {
  path: string; // relative, e.g. "videos_gifs/01_hero.mp4" or "raw/01_hero.webm"
  content: Buffer;
  contentType: string;
}

export interface ExtractMediaReport {
  url: string;
  status: 'ok' | 'failed';
  message: string;
  httpStatus: number | null;
  attempts: { attempt: number; headed: boolean; status: number | null; error: string | null }[];
  botCheck: boolean;
  counts: { videos_gifs: number; images: number };
  networkCounts: Record<string, number>;
  urlDuplicates: number;
  failedDownloads: { url: string; error: string }[];
  embeds: { url: string; resolved: string; result: string }[];
  embedsNotDownloaded: number; // count of `embeds` entries whose result started with "failed:"
  skipped: Record<string, number>;
}

export interface ExtractMediaResult {
  report: ExtractMediaReport;
  manifest: ManifestEntry[];
  files: ExtractMediaFile[];
}

interface StagedItem {
  url: string;
  kind: 'img' | 'video' | 'embed' | 'embed_recording';
  y: number | null;
  section?: string;
  ext: string;
  content: Buffer;
  tempPath: string;
  title?: string;
}

export async function extractMedia(url: string, opts: ExtractMediaOptions = {}): Promise<ExtractMediaResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'extract-media-'));
  const attempts: ExtractMediaReport['attempts'] = [];
  let httpStatus: number | null = null;
  let botCheck = false;
  const mediaRequests: MediaRequestLog[] = [];
  const network = new Map<string, NetworkEntry>();

  try {
    const { page, context, browser, ok } = await openPageWithRetry(url, opts, attempts, network, mediaRequests, (s) => (httpStatus = s), (b) => (botCheck = b));

    if (!ok || !page || !context || !browser) {
      return emptyResult(url, httpStatus, attempts, botCheck, mediaRequests);
    }

    const found: FoundMap = new Map();
    let headings: HeadingMark[] = [];
    let cands: Candidate[] = [];
    const embeds: ExtractMediaReport['embeds'] = [];

    try {
      await dismissConsent(page, 3);
      await page.evaluate(PROMOTE_LAZY_JS);
      await collect(page, found);
      await scrollPage(page, found);
      await dismissConsent(page, 1);
      await clickReveals(page, found);
      try {
        await page.evaluate(SCROLL_NESTED_JS);
      } catch {
        // matches the source's bare except around this best-effort pass
      }
      await page.evaluate('scrollTo(0, 0)');
      await page.waitForTimeout(300);
      headings = await page.evaluate<HeadingMark[]>(HEADINGS_JS);
      await collect(page, found, true);

      for (const [u, it] of found) {
        cands.push({ url: u, kind: it.kind, y: it.h > 0 ? it.y : null });
      }
      for (const [u, it] of network) {
        if (!found.has(u)) {
          cands.push({ url: u, kind: it.kind, y: null, ct: it.ct, section: 'network-only' });
        }
      }
      for (const c of cands) {
        if (c.kind === 'img' && isVideoUrl(c.url)) c.kind = 'video';
      }

      const nAll = cands.length;
      cands = dedupeCandidates(cands);
      const urlDuplicates = nAll - cands.length;

      const referer = page.url();
      const userAgent = await page.evaluate<string>('navigator.userAgent');
      const cookieHeader = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

      const staged: StagedItem[] = [];
      const failedDownloads: { url: string; error: string }[] = [];
      const embedCands = cands.filter((c) => c.kind === 'iframe' && EMBED_RE.test(c.url));

      for (const c of cands) {
        if (c.kind === 'iframe') continue;
        const stem = `staged-${staged.length}`;
        const result = await downloadAsset(c.url, referer, cookieHeader, userAgent, c.ct || '', tempDir, stem);
        if ('error' in result) {
          failedDownloads.push({ url: c.url, error: result.error });
          continue;
        }
        const tempPath = join(tempDir, `staged-${staged.length}${result.ext}`);
        await writeFile(tempPath, result.content);
        staged.push({ url: c.url, kind: c.kind, y: c.y, section: c.section, ext: result.ext, content: result.content, tempPath });
      }

      await context.close();
      await browser.close();

      // extract_assets.py's download_all() embed loop (lines 1578-1598):
      // one attempt per unique resolved embed target, yt-dlp first,
      // falling back to recording it playing.
      const seenEmbedTargets = new Set<string>();
      for (const c of embedCands) {
        const target = embedUrl(c.url);
        if (seenEmbedTargets.has(target)) continue;
        seenEmbedTargets.add(target);

        const stem = `embed-${embeds.length}`;
        const outcome: EmbedOutcome = await downloadOrRecordEmbed(c.url, referer, tempDir, stem, { headed: opts.headed });
        embeds.push({ url: outcome.url, resolved: outcome.resolved, result: outcome.result });
        if (outcome.staged) {
          const tempPath = join(tempDir, `${stem}${outcome.staged.ext}`);
          await writeFile(tempPath, outcome.staged.content);
          staged.push({
            url: c.url, kind: outcome.staged.kind, y: c.y, section: c.section,
            ext: outcome.staged.ext, content: outcome.staged.content, tempPath,
            title: outcome.staged.title || undefined,
          });
        }
      }
      const embedsNotDownloaded = embeds.filter((e) => e.result.startsWith('failed:')).length;

      const { manifest, files, skipped } = await categorizeAndPlace(staged, headings);

      const counts = {
        videos_gifs: manifest.filter((m) => m.category === 'videos_gifs').length,
        images: manifest.filter((m) => m.category === 'images').length,
      };

      const report: ExtractMediaReport = {
        url,
        status: 'ok',
        message: botCheck ? 'Site showed a bot check - results may be incomplete.' : '',
        httpStatus,
        attempts,
        botCheck,
        counts,
        networkCounts: networkCounts(network),
        urlDuplicates,
        failedDownloads,
        embeds,
        embedsNotDownloaded,
        skipped,
      };

      return { report, manifest, files };
    } catch (err) {
      try {
        await context.close();
      } catch {
        // already closing/closed
      }
      try {
        await browser.close();
      } catch {
        // already closing/closed
      }
      return {
        report: {
          url, status: 'failed',
          message: `Extraction crashed (${err instanceof Error ? err.constructor.name : 'Error'}) - nothing extracted.`,
          httpStatus, attempts, botCheck, counts: { videos_gifs: 0, images: 0 }, networkCounts: networkCounts(network),
          urlDuplicates: 0, failedDownloads: [], embeds, embedsNotDownloaded: embeds.filter((e) => e.result.startsWith('failed:')).length, skipped: {},
        },
        manifest: [],
        files: [],
      };
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function emptyResult(
  url: string,
  httpStatus: number | null,
  attempts: ExtractMediaReport['attempts'],
  botCheck: boolean,
  mediaRequests: MediaRequestLog[]
): ExtractMediaResult {
  void mediaRequests;
  const message = httpStatus
    ? `Site returned ${httpStatus} - nothing extracted. Try again.`
    : 'Site did not load (timed out) - nothing extracted. Try again.';
  return {
    report: {
      url, status: 'failed', message, httpStatus, attempts, botCheck,
      counts: { videos_gifs: 0, images: 0 }, networkCounts: { video: 0, gif: 0, webp: 0, image: 0 },
      urlDuplicates: 0, failedDownloads: [], embeds: [], embedsNotDownloaded: 0, skipped: {},
    },
    manifest: [],
    files: [],
  };
}

// extract_assets.py's open_page() (lines 578-632): iPhone-14 mobile
// load, retried up to 3 times with 5/10/20s backoff, the final attempt
// headed. Bot-check text detection on the first 2000 chars of page
// title+body.
async function openPageWithRetry(
  url: string,
  opts: ExtractMediaOptions,
  attempts: ExtractMediaReport['attempts'],
  network: Map<string, NetworkEntry>,
  mediaRequests: MediaRequestLog[],
  setHttpStatus: (s: number | null) => void,
  setBotCheck: (b: boolean) => void
) {
  const device = { ...devices[ASSET_DEVICE], viewport: VIEWPORT };

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const headed = attempt === BACKOFF_MS.length || opts.headed === true;
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
    }

    const browser = await chromium.launch({ headless: !headed, args: ['--autoplay-policy=no-user-gesture-required'] });
    const context = await browser.newContext(device);
    const page = await context.newPage();

    page.on('response', (resp) => {
      try {
        recordMedia(resp, network, mediaRequests);
      } catch {
        // matches the source's bare except in on_response
      }
    });

    let err: string | null = null;
    let status: number | null = null;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      status = resp ? resp.status() : null;
    } catch (e) {
      err = e instanceof Error ? e.message.split('\n')[0] : String(e);
    }

    attempts.push({ attempt: attempt + 1, headed, status, error: err });
    setHttpStatus(status);

    if (status !== null && status < 400) {
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        // matches the source's bare except
      }
      let text = '';
      try {
        const title = await page.title();
        const bodyText = await page.evaluate<string>(
          "document.body ? document.body.innerText.slice(0, 2000) : ''"
        );
        text = `${title} ${bodyText}`;
      } catch {
        text = '';
      }
      if (BOT_RE.test(text) && text.length < 1500) {
        setBotCheck(true);
      }
      return { page, context, browser, ok: true };
    }

    await context.close();
    await browser.close();
  }
  return { page: null, context: null, browser: null, ok: false };
}

async function sha256Hex(content: Buffer): Promise<string> {
  return createHash('sha256').update(content).digest('hex');
}

// extract_assets.py's per-cat `mkind` (line 1645: {"embedded": "video",
// "gifs": "animated", "images": "still"}), derived here from groupType
// since this port merges "embedded"/"gifs" into one "videos_gifs"
// category for storage purposes (see the dedup loop's comment above).
function familyOf(groupType: string): 'video' | 'animated' | 'still' {
  if (groupType === 'video' || groupType === 'embed' || groupType === 'embed_recording') return 'video';
  if (groupType === 'gif' || groupType.startsWith('animated_')) return 'animated';
  return 'still';
}

interface GroupedItem extends StagedItem {
  inspectKind: InspectKind;
  facts: InspectFacts;
  groupType: string;
  title?: string;
}

// extract_assets.py's finish() (lines 1602-1696) + place() (lines 1715-
// 1766), adapted from filesystem moves to in-memory buffers/storage
// keys. Dedup here is sha256 (exact) + phash/dHash (near-duplicate) —
// see this file's header comment for the one documented phash
// divergence.
async function categorizeAndPlace(
  staged: StagedItem[],
  headings: HeadingMark[]
): Promise<{ manifest: ManifestEntry[]; files: ExtractMediaFile[]; skipped: Record<string, number> }> {
  const skipped: Record<string, number> = {
    under_5kb: 0, too_small_px: 0, favicon: 0, tracking_pixel: 0, svg_too_small: 0, not_media: 0,
    duplicate_sha256: 0, duplicate_phash: 0, convert_failed: 0,
  };

  const groups: { videos_gifs: GroupedItem[]; images: GroupedItem[] } = { videos_gifs: [], images: [] };

  for (const it of staged) {
    const head = it.content.subarray(0, 1024);
    const { kind, facts } = await inspectAsset(it.tempPath, it.ext, head);

    if (kind === 'video') {
      // extract_assets.py's finish() line 1611: an "embed"/"embed_recording"
      // staged item keeps that as its type; everything else is "video".
      const groupType = it.kind === 'embed' || it.kind === 'embed_recording' ? it.kind : 'video';
      groups.videos_gifs.push({ ...it, inspectKind: kind, facts, groupType });
    } else if (kind === 'animated') {
      const fmt = facts.format || '?';
      const groupType = fmt === 'GIF' ? 'gif' : `animated_${fmt.toLowerCase()}`;
      groups.videos_gifs.push({ ...it, inspectKind: kind, facts, groupType });
    } else if (kind === 'still' || kind === 'gif-still') {
      const w = facts.width || 0;
      const h = facts.height || 0;
      if (facts.format === 'ICO' || FAVICON_RE.test(it.url)) {
        skipped.favicon += 1;
      } else if (Math.max(w, h) <= 3 || w * h <= 16 || (TRACKING_RE.test(it.url) && Math.max(w, h) < 50)) {
        skipped.tracking_pixel += 1;
      } else if (it.content.length < MIN_STILL_BYTES) {
        skipped.under_5kb += 1;
      } else if (Math.max(w, h) < 150) {
        skipped.too_small_px += 1;
      } else {
        groups.images.push({ ...it, inspectKind: kind, facts, groupType: 'image' });
      }
    } else if (kind === 'svg') {
      if (it.content.length < 30) {
        skipped.svg_too_small += 1;
      } else {
        groups.images.push({ ...it, inspectKind: kind, facts, groupType: 'svg' });
      }
    } else {
      skipped.not_media += 1;
    }
  }

  const manifest: ManifestEntry[] = [];
  const files: ExtractMediaFile[] = [];

  for (const cat of ['videos_gifs', 'images'] as const) {
    const items = groups[cat];
    items.sort((a, b) => (b.facts.width || 0) * (b.facts.height || 0) - (a.facts.width || 0) * (a.facts.height || 0));

    const kept: GroupedItem[] = [];
    const shaToItem = new Map<string, GroupedItem>();
    // phash/dHash comparisons are scoped per "family" within the
    // category — a video is only ever compared against other videos,
    // an animated image only against other animated images — matching
    // the source's embedded/gifs being separate groups entirely (both
    // just happen to share the "videos_gifs" output folder in this
    // port's simplified layout).
    const hashesByFamily = new Map<string, { item: GroupedItem; hash: bigint }[]>();

    for (const it of items) {
      const digest = await sha256Hex(it.content);
      const existing = shaToItem.get(digest);
      if (existing) {
        skipped.duplicate_sha256 += 1;
        if (it.y !== null && (existing.y === null || it.y < existing.y)) existing.y = it.y;
        continue;
      }

      const family = familyOf(it.groupType);
      const hash = await computeDHash(it.tempPath, middleFrameSeconds(it.facts.durationSeconds));
      if (hash !== null) {
        const bucket = hashesByFamily.get(family) ?? [];
        const twin = bucket.find(
          (h) => hammingDistance(hash, h.hash) <= NEAR_DUP && similarShape(it.facts, h.item.facts, cat)
        );
        if (twin) {
          skipped.duplicate_phash += 1;
          if (it.y !== null && (twin.item.y === null || it.y < twin.item.y)) twin.item.y = it.y;
          continue;
        }
        bucket.push({ item: it, hash });
        hashesByFamily.set(family, bucket);
      }

      shaToItem.set(digest, it);
      kept.push(it);
    }

    kept.sort((a, b) => {
      if ((a.y === null) !== (b.y === null)) return a.y === null ? 1 : -1;
      return (a.y || 0) - (b.y || 0);
    });

    let n = 0;
    for (const it of kept) {
      n += 1;
      let label = sectionFor(it.y, headings, ASSET_VIEWPORT.height);
      if (it.y === null && it.section) label = it.section;
      const stem = `${String(n).padStart(2, '0')}_${label}`;

      const placed = await placeItem(cat, it, stem);
      if (!placed) {
        skipped.convert_failed += 1;
        continue;
      }
      manifest.push({ ...placed.entry, pageOrder: n, pageY: it.y, section: label });
      files.push(...placed.files);
    }
  }

  return { manifest, files, skipped };
}

async function placeItem(
  cat: 'videos_gifs' | 'images',
  it: GroupedItem,
  stem: string
): Promise<{ entry: Omit<ManifestEntry, 'pageOrder' | 'pageY' | 'section'>; files: ExtractMediaFile[] } | null> {
  const baseEntry = {
    sourceUrl: it.url,
    originalFilename: originalName(it.url),
    width: it.facts.width,
    height: it.facts.height,
    durationSeconds: it.facts.durationSeconds,
  };

  if (cat === 'images') {
    if (it.groupType === 'svg') {
      const filename = `${stem}.svg`;
      return {
        entry: { ...baseEntry, category: 'images', type: 'svg', filename, path: `images/${filename}`, mp4: null, sizeBytes: it.content.length },
        files: [{ path: `images/${filename}`, content: it.content, contentType: 'image/svg+xml' }],
      };
    }
    let ext = it.ext.toLowerCase();
    if (ext === '.bin' || ext === '.jpeg') {
      const fmtExt: Record<string, string> = { JPEG: '.jpg', PNG: '.png', WEBP: '.webp', GIF: '.gif', AVIF: '.avif' };
      ext = fmtExt[it.facts.format || ''] || '.jpg';
    }
    const filename = `${stem}${ext}`;
    return {
      entry: { ...baseEntry, category: 'images', type: 'image', filename, path: `images/${filename}`, mp4: null, sizeBytes: it.content.length },
      files: [{ path: `images/${filename}`, content: it.content, contentType: contentTypeForExt(ext) }],
    };
  }

  // videos_gifs: either a plain video (groupType 'video') or an
  // animated image (groupType 'gif' | 'animated_<fmt>').
  if (it.groupType === 'gif' || it.groupType.startsWith('animated_')) {
    const fmtExt: Record<string, string> = { GIF: '.gif', WEBP: '.webp', PNG: '.png', AVIF: '.avif' };
    const ext = fmtExt[it.facts.format || ''] || it.ext;
    const filename = `${stem}${ext}`;
    const files: ExtractMediaFile[] = [{ path: `videos_gifs/${filename}`, content: it.content, contentType: contentTypeForExt(ext) }];

    let mp4Path: string | null = null;
    if (it.groupType === 'gif' || it.groupType.startsWith('animated_')) {
      const outPath = it.tempPath.replace(/\.[^.]+$/, '') + `-${stem}.mp4`;
      const converted =
        it.groupType === 'gif' ? await animatedGifToMp4(it.tempPath, outPath) : await animatedToMp4(it.tempPath, outPath);
      if (converted) {
        const normOutPath = outPath.replace(/\.mp4$/, '-norm.mp4');
        try {
          const normalized = await normalizeVideoFile(outPath, normOutPath, false);
          if (normalized.kept) {
            const mp4Content = await readFile(normOutPath);
            mp4Path = `${stem}.mp4`;
            files.push({ path: `videos_gifs/${mp4Path}`, content: mp4Content, contentType: 'video/mp4' });
          }
        } catch {
          // matches the source's "could not convert, mp4 stays null"
        }
      }
    }

    return {
      entry: {
        ...baseEntry, category: 'videos_gifs', type: it.groupType, filename,
        path: `videos_gifs/${filename}`, mp4: mp4Path ? `videos_gifs/${mp4Path}` : null, sizeBytes: it.content.length,
      },
      files,
    };
  }

  // Plain video, or an "embed"/"embed_recording" staged item (same
  // conversion path — extract_assets.py's place() only branches on
  // type for is_embed, the raw-copy skip, and original_filename).
  const isEmbed = it.groupType === 'embed' || it.groupType === 'embed_recording';

  const mp4OutPath = it.tempPath.replace(/\.[^.]+$/, '') + `-${stem}-mp4.mp4`;
  const converted = await toMp4Video(it.tempPath, mp4OutPath);
  if (!converted) return null;

  const normOutPath = mp4OutPath.replace(/\.mp4$/, '-norm.mp4');
  let normalized;
  try {
    normalized = await normalizeVideoFile(mp4OutPath, normOutPath, isEmbed);
  } catch {
    return null;
  }
  if (!normalized.kept) return null;

  const finalContent = await readFile(normOutPath);
  const filename = `${stem}.mp4`;
  const files: ExtractMediaFile[] = [{ path: `videos_gifs/${filename}`, content: finalContent, contentType: 'video/mp4' }];

  if (it.ext.toLowerCase() !== '.mp4' && it.groupType !== 'embed_recording') {
    files.push({ path: `raw/${stem}${it.ext}`, content: it.content, contentType: contentTypeForExt(it.ext) });
  }

  const originalFilename =
    it.groupType === 'embed_recording' ? 'recorded playing in the browser' : it.title || baseEntry.originalFilename;

  return {
    entry: {
      ...baseEntry, originalFilename, category: 'videos_gifs', type: it.groupType, filename, path: `videos_gifs/${filename}`,
      mp4: `videos_gifs/${filename}`, width: normalized.facts.width, height: normalized.facts.height,
      durationSeconds: normalized.facts.durationSeconds, sizeBytes: finalContent.length,
    },
    files,
  };
}

function contentTypeForExt(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.avif': 'image/avif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}
