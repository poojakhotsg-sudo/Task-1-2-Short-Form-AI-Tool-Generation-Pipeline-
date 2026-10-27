import { chromium, devices } from 'playwright';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { preparePage, FIND_BLOCKS_JS } from './pageInteraction.js';
import { CURSOR_JS, recordShot } from './recordShot.js';
import { shotClipName } from './pageSections.js';
import { HEADINGS_JS, matchHeading, type PageHeading } from './headingMatch.js';
import { cutClipToVertical, getClipDurationSeconds } from '../lib/ffmpeg.js';
import { checkClip } from './qa/checkClip.js';

// PIPE-05's not-ported fallback, ported from grabber.py's
// record_missing_shot_clips() (lines 1471-1535). Called by match.ts
// (web-next) for any website-sourced shot that Rules 1/1b/2 couldn't
// match to an existing clip — one more mobile-viewport recording pass,
// this time aimed at the specific heading each shot's visual_needed
// text names, rather than grab()'s generic "most prominent sections."
//
// A real behavior difference from the source, not a silent one: in
// matcher.py, the shot dicts passed into this function never carry a
// "status": "pending" field (build_shots() doesn't set one), but
// _find_shot_sections() only attempts heading-matching for shots where
// `status == "pending"` — so every call from match() finds 0 headings
// and this function degrades to pure "mark missing," regardless of
// whether a matching heading actually exists on the page. That's a
// latent bug in the pairing of these two files, not a deliberate skip:
// the whole point of this function is to find real footage for a shot
// that nothing else matched. This port fixes it by attempting heading-
// matching for every shot the caller passes in (callers are expected to
// pass only genuinely-still-unmatched shots, same as matcher.py's
// `pending` list) — restoring the function's documented intent instead
// of faithfully reproducing a bug that makes the whole function a no-op
// in its only real caller.
export interface PendingShot {
  shot: number;
  visualNeeded: string;
  scriptLine: string;
  durationSeconds: number;
}

export interface RecordedShotResult {
  shot: number;
  file: string | null; // e.g. "shot02_dashboard.mp4" — caller decides the storage prefix
  content: Buffer | null;
  status: 'ok' | 'missing';
  error: string | null;
  seconds: number | null;
  qa: 'pass' | 'fail' | null;
  qaReasons: string[];
  matchedHeading: string | null;
}

const VIEWPORT = { width: 390, height: 844 };
const RECORD_SECONDS = 6.0; // grabber.py's record_missing_shot_clips() default

interface BlocksInfo {
  height: number;
  vh: number;
}

export async function recordMissingShotClips(
  url: string,
  shots: PendingShot[],
  opts: { headed?: boolean } = {}
): Promise<RecordedShotResult[]> {
  if (shots.length === 0) return [];

  const tempDir = await mkdtemp(join(tmpdir(), 'record-missing-shots-'));
  let browser: import('playwright').Browser | null = null;

  try {
    browser = await chromium.launch({ headless: !opts.headed });
    const device = { ...devices['iPhone 14'], viewport: VIEWPORT, isMobile: true, hasTouch: true };
    const context = await browser.newContext({ ...device, recordVideo: { dir: tempDir, size: VIEWPORT } });
    context.setDefaultTimeout(20000);
    const page = await context.newPage();

    const t0 = Date.now();
    const matched: { shot: PendingShot; heading: PageHeading; segment: [number, number] }[] = [];
    const unmatched: { shot: PendingShot; reason: string }[] = [];
    let webmPath: string | null = null;

    try {
      await preparePage(page, url);
      await page.evaluate(CURSOR_JS);
      const info = await page.evaluate<BlocksInfo>(FIND_BLOCKS_JS);
      const maxY = Math.max(0, info.height - info.vh);
      const headings = await page.evaluate<PageHeading[]>(HEADINGS_JS);

      for (const shot of shots) {
        const { heading, reason } = matchHeading(shot.visualNeeded, headings);
        if (!heading) {
          unmatched.push({ shot, reason: reason || 'no matching heading' });
          continue;
        }
        try {
          const segment = await recordShot(page, { y: heading.y, h: heading.h, text: '', title: heading.text, video: false }, maxY, info.vh, RECORD_SECONDS, t0);
          matched.push({ shot, heading, segment });
        } catch (err) {
          unmatched.push({ shot, reason: `recording failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    } finally {
      const video = page.video();
      await context.close();
      webmPath = video ? await video.path() : null;
    }

    const results: RecordedShotResult[] = [];

    for (const { shot, heading, segment } of matched) {
      if (!webmPath) {
        unmatched.push({ shot, reason: 'no session recording was produced' });
        continue;
      }
      const filename = shotClipName(shot.shot, shot.visualNeeded);
      const outPath = join(tempDir, filename);
      try {
        await cutClipToVertical(webmPath, segment[0], segment[1], outPath, RECORD_SECONDS);
      } catch (err) {
        unmatched.push({ shot, reason: `cut failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      let seconds: number | null = null;
      try {
        seconds = await getClipDurationSeconds(outPath);
      } catch {
        seconds = null;
      }
      const { metrics, reasons } = await checkClip(outPath);

      results.push({
        shot: shot.shot,
        file: filename,
        content: await readFile(outPath),
        status: 'ok',
        error: null,
        seconds: seconds ?? metrics.seconds,
        qa: reasons.length > 0 ? 'fail' : 'pass',
        qaReasons: reasons,
        matchedHeading: heading.text,
      });
    }

    for (const { shot, reason } of unmatched) {
      results.push({
        shot: shot.shot,
        file: null,
        content: null,
        status: 'missing',
        error: `insufficient website assets for visual: '${shot.visualNeeded || shot.scriptLine}' (${reason})`,
        seconds: null,
        qa: null,
        qaReasons: [],
        matchedHeading: null,
      });
    }

    return results;
  } catch (err) {
    // Matches grabber.py's outer try/except around the whole session:
    // a session-level failure (browser crash, navigation error) doesn't
    // propagate — every pending shot is reported "missing" instead,
    // same as the source's fallback behavior.
    return shots.map((shot) => ({
      shot: shot.shot,
      file: null,
      content: null,
      status: 'missing',
      error: `insufficient website assets for visual: '${shot.visualNeeded || shot.scriptLine}' (could not record per-shot mobile clips: ${err instanceof Error ? err.message : String(err)})`,
      seconds: null,
      qa: null,
      qaReasons: [],
      matchedHeading: null,
    }));
  } finally {
    if (browser) await browser.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}
