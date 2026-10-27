import { describe, it, expect } from 'vitest';
import { slug, sectionFor, guessExt, isVideoUrl, assetKey, dedupeCandidates, originalName, humanBytes, hammingDistance, similarShape } from '../pure.js';

describe('slug', () => {
  it('lowercases and replaces non-alphanumeric runs with a hyphen', () => {
    expect(slug('Hello, World!')).toBe('hello-world');
  });

  it('strips diacritics and non-ascii characters', () => {
    expect(slug('Café Münster')).toBe('cafe-munster');
  });

  it('falls back to "section" for empty or unusable input', () => {
    expect(slug('')).toBe('section');
    expect(slug('!!!')).toBe('section');
  });

  it('caps length without cutting a word in half when a hyphen exists past the midpoint', () => {
    const out = slug('this is a fairly long heading about something', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('-')).toBe(false);
  });
});

describe('sectionFor', () => {
  it('returns "page" when y is null', () => {
    expect(sectionFor(null, [])).toBe('page');
  });

  it('returns "hero" above the fold when there are no prior headings', () => {
    expect(sectionFor(100, [], 844)).toBe('hero');
  });

  it('returns "section" below the fold when there are no prior headings', () => {
    expect(sectionFor(900, [], 844)).toBe('section');
  });

  it('returns the slug of the nearest heading above (within 40px tolerance)', () => {
    const headings = [{ y: 50, text: 'Features' }, { y: 500, text: 'Pricing' }];
    expect(sectionFor(520, headings)).toBe('pricing');
    expect(sectionFor(200, headings)).toBe('features');
  });
});

describe('guessExt', () => {
  it('uses the URL path extension when it looks like a real extension', () => {
    expect(guessExt('https://example.com/a/b.PNG')).toBe('.png');
  });

  it('normalizes .jpeg to .jpg', () => {
    expect(guessExt('https://example.com/a.jpeg')).toBe('.jpg');
  });

  it('falls back to the content-type mapping when the path has no usable extension', () => {
    expect(guessExt('https://example.com/image', 'image/webp')).toBe('.webp');
  });

  it('falls back to .bin when neither the path nor content-type resolve', () => {
    expect(guessExt('https://example.com/image', '')).toBe('.bin');
  });
});

describe('isVideoUrl', () => {
  it('matches a plain video extension', () => {
    expect(isVideoUrl('https://example.com/clip.mp4')).toBe(true);
  });

  it('matches a video content-type', () => {
    expect(isVideoUrl('https://example.com/clip', 'video/webm')).toBe(true);
  });

  it('rejects an HLS segment URL even with a video-looking content type', () => {
    expect(isVideoUrl('https://example.com/seg-001.ts', 'video/mp4')).toBe(false);
  });

  it('rejects a plain image URL', () => {
    expect(isVideoUrl('https://example.com/pic.jpg', 'image/jpeg')).toBe(false);
  });
});

describe('assetKey', () => {
  it('is identical for the same path with only variant query params differing', () => {
    const a = assetKey('https://example.com/img.jpg?w=200&utm_source=x');
    const b = assetKey('https://example.com/img.jpg?w=800');
    expect(a[0]).toBe(b[0]);
    expect(a[1]).toBe(b[1]);
  });

  it('differs for a real query param that changes the asset', () => {
    const a = assetKey('https://example.com/img.jpg?id=1');
    const b = assetKey('https://example.com/img.jpg?id=2');
    expect(a).not.toEqual(b);
  });

  it('does not throw on a malformed URL', () => {
    expect(() => assetKey('not a url')).not.toThrow();
  });
});

describe('dedupeCandidates', () => {
  it('keeps one candidate per asset, preferring the larger width variant', () => {
    const cands = [
      { url: 'https://example.com/img.jpg?w=200', kind: 'img' as const, y: 10 },
      { url: 'https://example.com/img.jpg?w=1600', kind: 'img' as const, y: null },
    ];
    const out = dedupeCandidates(cands);
    expect(out).toHaveLength(1);
    expect(out[0].url).toContain('w=1600');
  });

  it('carries the page position over to the kept variant when the winner had none', () => {
    const cands = [
      { url: 'https://example.com/img.jpg?w=200', kind: 'img' as const, y: 42 },
      { url: 'https://example.com/img.jpg?w=1600', kind: 'img' as const, y: null },
    ];
    const out = dedupeCandidates(cands);
    expect(out[0].y).toBe(42);
  });

  it('keeps distinct kinds for the same URL separately', () => {
    const cands = [
      { url: 'https://example.com/a', kind: 'img' as const, y: null },
      { url: 'https://example.com/a', kind: 'video' as const, y: null },
    ];
    expect(dedupeCandidates(cands)).toHaveLength(2);
  });

  it('keeps distinct assets separate', () => {
    const cands = [
      { url: 'https://example.com/a.jpg', kind: 'img' as const, y: null },
      { url: 'https://example.com/b.jpg', kind: 'img' as const, y: null },
    ];
    expect(dedupeCandidates(cands)).toHaveLength(2);
  });
});

describe('originalName', () => {
  it('decodes and returns the last URL path segment', () => {
    expect(originalName('https://example.com/a/b%20c.jpg')).toBe('b c.jpg');
  });

  it('falls back to "file" for a URL with no path segment', () => {
    expect(originalName('https://example.com/')).toBe('file');
  });
});

describe('humanBytes', () => {
  it('formats under 1MB as KB', () => {
    expect(humanBytes(500 * 1024)).toBe('500 KB');
  });

  it('formats 1MB and over as MB', () => {
    expect(humanBytes(2 * 1048576)).toBe('2.0 MB');
  });
});

describe('hammingDistance', () => {
  it('is 0 for identical hashes', () => {
    expect(hammingDistance(0b1011n, 0b1011n)).toBe(0);
  });

  it('counts the number of differing bits', () => {
    expect(hammingDistance(0b0000n, 0b1111n)).toBe(4);
    expect(hammingDistance(0b1010n, 0b0101n)).toBe(4);
    expect(hammingDistance(0b1010n, 0b1000n)).toBe(1);
  });

  it('handles full 64-bit hashes', () => {
    const a = 0xffffffffffffffffn;
    const b = 0x0000000000000000n;
    expect(hammingDistance(a, b)).toBe(64);
  });
});

describe('similarShape', () => {
  it('always returns true for a non-images category, regardless of shape', () => {
    expect(similarShape({ width: 100, height: 100 }, { width: 400, height: 50 }, 'videos_gifs')).toBe(true);
  });

  it('returns true for images with nearly the same aspect ratio', () => {
    expect(similarShape({ width: 1000, height: 500 }, { width: 998, height: 500 }, 'images')).toBe(true);
  });

  it('returns false for images with clearly different aspect ratios', () => {
    expect(similarShape({ width: 1000, height: 500 }, { width: 500, height: 1000 }, 'images')).toBe(false);
  });

  it('returns false when a dimension is missing', () => {
    expect(similarShape({ width: null, height: 500 }, { width: 500, height: 500 }, 'images')).toBe(false);
  });
});
