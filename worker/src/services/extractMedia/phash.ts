import { extractGrayscaleFrameRaw } from '../../lib/ffmpeg.js';

// extract_assets.py's phash()/middle_frame() (lines 1037-1059), re-based
// on ffmpeg instead of PIL + imagehash — same reasoning as inspect.ts's
// file-level comment: this worker has no Node image library, and
// ffmpeg/ffprobe are already a hard dependency (Section 6), so this
// reuses extractGrayscaleFrameRaw() (already built for qa/checkClip.ts)
// rather than adding a new native dependency.
//
// A real algorithm difference, not silent: imagehash.phash() is a
// DCT-based hash; this computes a difference hash (dHash) instead — a
// different, simpler perceptual hash with the same purpose (near-
// duplicate detection) and the same 64-bit/Hamming-distance shape, so
// extract_assets.py's NEAR_DUP = 4 threshold carries over unchanged.
// dHash and phash will not produce bit-identical hashes for the same
// image, and may disagree on some borderline near-duplicates a true
// phash would catch (or vice versa) — this is a faithful-in-spirit, not
// bit-for-bit, port of this one piece.
const HASH_W = 9; // 9 columns x 8 rows -> 8 horizontal-gradient bits per row = 64 bits total
const HASH_H = 8;

// Returns null (never throws) exactly where the source's phash()/
// middle_frame() would return None — a frame extraction failure (e.g.
// a 0-duration or corrupt file) just means "no hash to compare," not a
// fatal error for the caller's dedup pass.
export async function computeDHash(path: string, atSeconds: number): Promise<bigint | null> {
  let gray: Buffer;
  try {
    gray = await extractGrayscaleFrameRaw(path, Math.max(0, atSeconds), HASH_W, HASH_H);
  } catch {
    return null;
  }

  let hash = 0n;
  for (let row = 0; row < HASH_H; row++) {
    for (let col = 0; col < HASH_W - 1; col++) {
      const left = gray[row * HASH_W + col];
      const right = gray[row * HASH_W + col + 1];
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}

// extract_assets.py's middle_frame()'s choice of timestamp: the middle
// of the clip for anything with a duration, frame 0 for a still image
// (duration null/0).
export function middleFrameSeconds(durationSeconds: number | null): number {
  return durationSeconds && durationSeconds > 0 ? durationSeconds / 2 : 0;
}
