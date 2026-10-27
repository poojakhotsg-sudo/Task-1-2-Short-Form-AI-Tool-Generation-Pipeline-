import { describe, it, expect } from 'vitest';
import { evaluateMetrics, isStatic, shouldKeepOriginalTake } from '../services/qa/checkClip.js';

// Baseline "good clip" inputs (passes every check) — tests then vary one
// dimension at a time to isolate which threshold is being exercised.
const GOOD_SECONDS = 9;
const GOOD_WIDTH = 1080;
const GOOD_HEIGHT = 1920;
const GOOD_SHARP = Array(12).fill(1000); // >= 500
const GOOD_BLANK = 0; // <= 6 (half of 12)
const GOOD_MOTION = Array(11).fill(2.0); // >= 1.0, so not "static"

describe('evaluateMetrics', () => {
  it('passes (empty reasons) for a clip within every threshold', () => {
    const { reasons } = evaluateMetrics(GOOD_SECONDS, GOOD_WIDTH, GOOD_HEIGHT, GOOD_SHARP, GOOD_BLANK, GOOD_MOTION);
    expect(reasons).toEqual([]);
  });

  it.each([
    [2.9, true], // just under MIN_S=3
    [3.0, false], // inclusive boundary
    [15.0, false], // inclusive boundary
    [15.1, true], // just over MAX_S=15
  ])('flags length only outside [3, 15]s (seconds=%s)', (seconds, shouldFail) => {
    const { reasons } = evaluateMetrics(seconds, GOOD_WIDTH, GOOD_HEIGHT, GOOD_SHARP, GOOD_BLANK, GOOD_MOTION);
    const hasLengthReason = reasons.some((r) => r.startsWith('length'));
    expect(hasLengthReason).toBe(shouldFail);
  });

  it('flags any resolution other than exactly 1080x1920', () => {
    const { reasons } = evaluateMetrics(GOOD_SECONDS, 1920, 1080, GOOD_SHARP, GOOD_BLANK, GOOD_MOTION); // swapped
    expect(reasons.some((r) => r.startsWith('resolution'))).toBe(true);
  });

  it('flags "no decodable frames" when sharp[] is empty, and skips sharpness/blank/motion checks entirely in that case', () => {
    const { reasons } = evaluateMetrics(GOOD_SECONDS, GOOD_WIDTH, GOOD_HEIGHT, [], 0, []);
    expect(reasons).toContain('no decodable frames');
    expect(reasons.some((r) => r.startsWith('blurry'))).toBe(false);
  });

  it.each([
    [499, true],
    [500, false], // inclusive boundary — median >= 500 passes
    [501, false],
  ])('flags blurry only when median sharpness < 500 (median=%s)', (sharpness, shouldFail) => {
    const { reasons } = evaluateMetrics(GOOD_SECONDS, GOOD_WIDTH, GOOD_HEIGHT, [sharpness], GOOD_BLANK, GOOD_MOTION);
    expect(reasons.some((r) => r.startsWith('blurry'))).toBe(shouldFail);
  });

  it('flags "mostly blank" only when more than half the sampled frames are flat', () => {
    const sharp = Array(12).fill(1000);
    const halfBlank = evaluateMetrics(GOOD_SECONDS, GOOD_WIDTH, GOOD_HEIGHT, sharp, 6, GOOD_MOTION); // exactly half — not ">"
    const majorityBlank = evaluateMetrics(GOOD_SECONDS, GOOD_WIDTH, GOOD_HEIGHT, sharp, 7, GOOD_MOTION); // > half

    expect(halfBlank.reasons.some((r) => r.startsWith('mostly blank'))).toBe(false);
    expect(majorityBlank.reasons.some((r) => r.startsWith('mostly blank'))).toBe(true);
  });

  it('flags "mostly static" only when more than half the frame-pair diffs are below the motion threshold', () => {
    const sharp = Array(12).fill(1000);
    // 11 motion samples (12 frames - 1): exactly half static (5.5 -> 5, not > 5.5) vs majority static.
    const halfStatic = [0.5, 0.5, 0.5, 0.5, 0.5, 2, 2, 2, 2, 2, 2]; // 5 static of 11 -> not > 5.5
    const majorityStatic = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 2, 2, 2, 2, 2]; // 6 static of 11 -> > 5.5

    const a = evaluateMetrics(GOOD_SECONDS, GOOD_WIDTH, GOOD_HEIGHT, sharp, 0, halfStatic);
    const b = evaluateMetrics(GOOD_SECONDS, GOOD_WIDTH, GOOD_HEIGHT, sharp, 0, majorityStatic);

    expect(a.reasons.some((r) => r.startsWith('mostly static'))).toBe(false);
    expect(b.reasons.some((r) => r.startsWith('mostly static'))).toBe(true);
  });

  it('rounds metrics.seconds to 1 decimal, sharpness (median) to 1 decimal, motion (mean) to 2 decimals', () => {
    const { metrics } = evaluateMetrics(9.456, GOOD_WIDTH, GOOD_HEIGHT, [1234.56, 2000], 0, [1.005, 2.0]);
    expect(metrics.seconds).toBe(9.5);
    expect(metrics.sharpness).toBe(1617.3); // median([1234.56, 2000]) = 1617.28 -> 1617.3
    expect(metrics.motion).toBe(1.5); // mean([1.005, 2.0]) = 1.5025 -> 1.5 (2dp)
  });

  it('reports metrics.sharpness/motion as null when there are no samples, rather than 0 or NaN', () => {
    const { metrics } = evaluateMetrics(GOOD_SECONDS, GOOD_WIDTH, GOOD_HEIGHT, [], 0, []);
    expect(metrics.sharpness).toBeNull();
    expect(metrics.motion).toBeNull();
  });
});

describe('isStatic', () => {
  it('is true only when a reason starts with "mostly static"', () => {
    expect(isStatic(['mostly static (6/11 frame pairs unchanged)'])).toBe(true);
    expect(isStatic(['blurry (sharpness 10, want >= 500)'])).toBe(false);
    expect(isStatic([])).toBe(false);
  });
});

describe('shouldKeepOriginalTake', () => {
  // grabber.py lines 1458-1467: "if _is_static(reasons) and metrics.get('motion', 0) <= prev_motion: keep original."
  it('keeps the original when the retry is still static and no more motion than the original', () => {
    expect(shouldKeepOriginalTake(1.0, ['mostly static (6/11 frame pairs unchanged)'], 0.8)).toBe(true);
    expect(shouldKeepOriginalTake(1.0, ['mostly static (6/11 frame pairs unchanged)'], 1.0)).toBe(true); // equal counts as "no better"
  });

  it('replaces with the retry when it is still static but has MORE motion than the original (genuine improvement, even if not enough to pass)', () => {
    expect(shouldKeepOriginalTake(0.5, ['mostly static (6/11 frame pairs unchanged)'], 0.9)).toBe(false);
  });

  it('replaces with the retry whenever it is no longer static at all, regardless of motion comparison', () => {
    expect(shouldKeepOriginalTake(5.0, [], 0.1)).toBe(false); // retry passes outright, even with low motion value
  });

  it('treats a null original motion as 0, not as "unknown/skip the comparison"', () => {
    // matches qa.py's `metrics.get('motion', 0)` default — a clip with
    // no prior motion metric (e.g. "no decodable frames" on the first
    // take) is treated as motion=0, so almost any retry motion counts
    // as an improvement.
    expect(shouldKeepOriginalTake(null, ['mostly static (1/1)'], 0)).toBe(true); // 0 <= 0, still no better
    expect(shouldKeepOriginalTake(null, ['mostly static (1/1)'], 0.5)).toBe(false);
  });
});
