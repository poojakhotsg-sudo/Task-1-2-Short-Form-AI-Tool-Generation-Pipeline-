import { probeVideo, extractGrayscaleFrameRaw } from '../../lib/ffmpeg.js';
import { laplacianVariance, stddev, meanAbsDiff, median, mean } from './imageMetrics.js';

// qa.py's thresholds (PIPE-06), ported verbatim — not recalibrated.
const MIN_S = 3.0;
const MAX_S = 15.0;
const WIDTH = 1080;
const HEIGHT = 1920;
const SHARPNESS_MIN = 500.0;
const BLANK_STD_MAX = 8.0;
const MOTION_MIN = 1.0;
const SAMPLES = 12;
const SAMPLE_WIDTH = 360; // qa.py resizes to 360px wide before analysis

export interface QaMetrics {
  seconds: number | null;
  size: string | null;
  sharpness: number | null;
  motion: number | null;
}

export interface QaResult {
  metrics: QaMetrics;
  reasons: string[];
}

// The pure decision logic from qa.py's check_clip() (lines 72-93), split
// out from the ffmpeg/video orchestration below so it's directly
// unit-testable with synthetic inputs — same split used for every other
// "real I/O + pure decision" pairing in this project (match.ts's
// scriptParser, pageSections.ts).
export function evaluateMetrics(
  seconds: number,
  width: number,
  height: number,
  sharp: number[],
  blankCount: number,
  motion: number[]
): QaResult {
  const reasons: string[] = [];

  if (!(seconds >= MIN_S && seconds <= MAX_S)) {
    reasons.push(`length ${seconds.toFixed(1)}s (want ${MIN_S.toFixed(0)}-${MAX_S.toFixed(0)}s)`);
  }
  if (width !== WIDTH || height !== HEIGHT) {
    reasons.push(`resolution ${width}x${height} (want ${WIDTH}x${HEIGHT})`);
  }

  if (sharp.length === 0) {
    reasons.push('no decodable frames');
  } else {
    const medSharp = median(sharp);
    if (medSharp < SHARPNESS_MIN) {
      reasons.push(`blurry (sharpness ${medSharp.toFixed(0)}, want >= ${SHARPNESS_MIN.toFixed(0)})`);
    }
    if (blankCount > sharp.length / 2) {
      reasons.push(`mostly blank (${blankCount}/${sharp.length} frames flat)`);
    }
    const staticCount = motion.filter((m) => m < MOTION_MIN).length;
    if (motion.length > 0 && staticCount > motion.length / 2) {
      reasons.push(`mostly static (${staticCount}/${motion.length} frame pairs unchanged)`);
    }
  }

  const metrics: QaMetrics = {
    seconds: Math.round(seconds * 10) / 10,
    size: `${width}x${height}`,
    sharpness: sharp.length > 0 ? Math.round(median(sharp) * 10) / 10 : null,
    motion: motion.length > 0 ? Math.round(mean(motion) * 100) / 100 : null,
  };

  return { metrics, reasons };
}

// qa.py's frame_stats() + check_clip(), real I/O orchestration. Honest
// deviation from the source, flagged rather than hidden: qa.py samples
// by FRAME INDEX (via OpenCV's frame count + np.linspace), ported here
// as evenly-spaced TIME samples across the probed duration instead —
// extracting an exact nth decoded frame without a native video-decoding
// binding (this worker has none; Section 6 leaves that an open choice)
// isn't practical with ffmpeg CLI alone. Time-based sampling serves the
// same purpose (12 evenly-spread samples across the clip) and produces
// equivalent pass/fail outcomes for the threshold comparisons this
// feeds, but will not reproduce qa.py's metrics bit-for-bit.
export async function checkClip(path: string): Promise<QaResult> {
  let seconds: number, width: number, height: number;
  try {
    ({ seconds, width, height } = await probeVideo(path));
  } catch (err) {
    return {
      metrics: { seconds: null, size: null, sharpness: null, motion: null },
      reasons: [`unreadable video (${err instanceof Error ? err.constructor.name : 'Error'})`],
    };
  }

  const sampleHeight = Math.max(1, Math.trunc((SAMPLE_WIDTH * height) / width));
  const sharp: number[] = [];
  const motion: number[] = [];
  let blankCount = 0;
  let prevFrame: Buffer | null = null;

  for (let i = 0; i < SAMPLES; i++) {
    const t = SAMPLES > 1 ? (seconds * i) / (SAMPLES - 1) : 0;
    let frame: Buffer;
    try {
      frame = await extractGrayscaleFrameRaw(path, t, SAMPLE_WIDTH, sampleHeight);
    } catch {
      continue; // matches qa.py's `if not ok: continue` on an undecodable frame
    }

    sharp.push(laplacianVariance(frame, SAMPLE_WIDTH, sampleHeight));
    if (stddev(frame) < BLANK_STD_MAX) blankCount += 1;
    if (prevFrame) motion.push(meanAbsDiff(frame, prevFrame));
    prevFrame = frame;
  }

  return evaluateMetrics(seconds, width, height, sharp, blankCount, motion);
}

// qa.py's `_is_static(reasons)` — used by the capture_site static-clip
// retry to decide which clips need a second pass.
export function isStatic(reasons: string[]): boolean {
  return reasons.some((r) => r.startsWith('mostly static'));
}

// grabber.py lines 1458-1467's keep-vs-replace decision after a
// static-clip retry: "no better: keep the first take, still a fail."
// Pulled out as a pure function (same split as evaluateMetrics above) so
// this specific comparison — the one that decides whether a retry's
// extra recording session actually accomplished anything — is directly
// testable without needing a real browser/ffmpeg retry pass.
export function shouldKeepOriginalTake(
  originalMotion: number | null,
  retryReasons: string[],
  retryMotion: number | null
): boolean {
  return isStatic(retryReasons) && (retryMotion ?? 0) <= (originalMotion ?? 0);
}
