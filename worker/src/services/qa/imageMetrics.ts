// Pure pixel-buffer math behind qa.py's frame_stats() (PIPE-06). Each
// function takes an 8-bit single-channel (grayscale) buffer and the
// frame's width/height — no ffmpeg/video decoding here, so these are
// directly unit-testable with synthetic buffers, same split used
// elsewhere in this worker (pageSections.ts, scriptParser.ts in
// web-next).
//
// Honest caveat: qa.py computes these via OpenCV (cv2.Laplacian,
// cv2.absdiff, numpy std/var), which has its own specific border-
// handling and floating-point behavior. This port implements the same
// 3x3 Laplacian kernel and the same formulas (variance, population
// stddev, mean absolute difference), but uses edge-clamped border
// handling for the Laplacian convolution rather than OpenCV's default
// BORDER_REFLECT_101 — the two will not produce bit-identical sharpness
// values. For QA's actual use (threshold comparisons against empirically
// calibrated cutoffs, not exact reproduction), this is a reasonable,
// explicitly-flagged approximation, not silently assumed equivalent.

function at(buf: Buffer, width: number, height: number, x: number, y: number): number {
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  return buf[cy * width + cx];
}

// 3x3 Laplacian kernel [[0,1,0],[1,-4,1],[0,1,0]] — the same kernel
// cv2.Laplacian uses with its default ksize=1.
export function laplacianVariance(buf: Buffer, width: number, height: number): number {
  const n = width * height;
  if (n === 0) return 0;

  const responses = new Float64Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const center = at(buf, width, height, x, y);
      const sum =
        at(buf, width, height, x - 1, y) +
        at(buf, width, height, x + 1, y) +
        at(buf, width, height, x, y - 1) +
        at(buf, width, height, x, y + 1) -
        4 * center;
      responses[y * width + x] = sum;
    }
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += responses[i];
  mean /= n;

  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = responses[i] - mean;
    variance += d * d;
  }
  return variance / n;
}

// Population standard deviation of pixel values — matches numpy's
// default ddof=0 (grey.std() in qa.py uses numpy's array .std(), which
// defaults to population stddev, not sample stddev).
export function stddev(buf: Buffer): number {
  const n = buf.length;
  if (n === 0) return 0;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += buf[i];
  mean /= n;

  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = buf[i] - mean;
    variance += d * d;
  }
  return Math.sqrt(variance / n);
}

// Mean absolute pixel-wise difference between two equally-sized frames —
// matches np.mean(cv2.absdiff(grey, prev)).
export function meanAbsDiff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) {
    throw new Error(`meanAbsDiff: buffer length mismatch (${a.length} vs ${b.length})`);
  }
  if (a.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
