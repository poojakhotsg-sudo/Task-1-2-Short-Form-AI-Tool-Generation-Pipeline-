import { describe, it, expect } from 'vitest';
import { laplacianVariance, stddev, meanAbsDiff, median, mean } from '../services/qa/imageMetrics.js';

function uniformBuffer(width: number, height: number, value: number): Buffer {
  return Buffer.alloc(width * height, value);
}

describe('laplacianVariance', () => {
  it('is zero for a perfectly flat (uniform) image', () => {
    const buf = uniformBuffer(10, 10, 128);
    expect(laplacianVariance(buf, 10, 10)).toBe(0);
  });

  it('is higher for a checkerboard (high contrast, every pixel an edge) than for a flat image', () => {
    const width = 10, height = 10;
    const flat = uniformBuffer(width, height, 128);
    const checker = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        checker[y * width + x] = (x + y) % 2 === 0 ? 0 : 255;
      }
    }

    expect(laplacianVariance(checker, width, height)).toBeGreaterThan(laplacianVariance(flat, width, height));
  });

  it('returns 0 for an empty buffer (width*height=0) rather than NaN or throwing', () => {
    expect(laplacianVariance(Buffer.alloc(0), 0, 0)).toBe(0);
  });
});

describe('stddev', () => {
  it('is zero for a uniform buffer', () => {
    expect(stddev(uniformBuffer(5, 5, 50))).toBe(0);
  });

  it('matches the population stddev formula for a known small buffer', () => {
    // Values [0, 10]: mean=5, variance=((0-5)^2+(10-5)^2)/2=25, stddev=5.
    const buf = Buffer.from([0, 10]);
    expect(stddev(buf)).toBe(5);
  });

  it('is high for a buffer with extreme contrast (0s and 255s)', () => {
    const buf = Buffer.from([0, 255, 0, 255]);
    expect(stddev(buf)).toBeGreaterThan(100);
  });
});

describe('meanAbsDiff', () => {
  it('is zero for two identical buffers', () => {
    const a = Buffer.from([10, 20, 30]);
    expect(meanAbsDiff(a, Buffer.from([10, 20, 30]))).toBe(0);
  });

  it('computes the mean absolute difference exactly for a known pair', () => {
    // |10-0| + |20-10| + |30-50| = 10 + 10 + 20 = 40; mean = 40/3
    const a = Buffer.from([10, 20, 30]);
    const b = Buffer.from([0, 10, 50]);
    expect(meanAbsDiff(a, b)).toBeCloseTo(40 / 3, 10);
  });

  it('throws on mismatched buffer lengths rather than silently truncating', () => {
    expect(() => meanAbsDiff(Buffer.from([1, 2]), Buffer.from([1, 2, 3]))).toThrow(/length mismatch/);
  });
});

describe('median', () => {
  it('averages the two middle values for an even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns the middle value for an odd-length array', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('returns 0 for an empty array', () => {
    expect(median([])).toBe(0);
  });
});

describe('mean', () => {
  it('computes the arithmetic mean', () => {
    expect(mean([1, 2, 3])).toBe(2);
  });

  it('returns 0 for an empty array', () => {
    expect(mean([])).toBe(0);
  });
});
