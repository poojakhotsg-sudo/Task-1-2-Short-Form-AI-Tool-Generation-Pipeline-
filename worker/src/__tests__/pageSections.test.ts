import { describe, it, expect } from 'vitest';
import { pickSections, libraryName, slugify, shotClipName, type PageBlock } from '../services/pageSections.js';

function block(title: string, y = 0, h = 500): PageBlock {
  return { y, h, text: title, title, video: false };
}

describe('pickSections', () => {
  it('dedupes by title, keeping first occurrence, in original order', () => {
    const blocks = [block('Hero'), block('Features'), block('Hero'), block('Pricing')];

    const picks = pickSections(blocks, 8);

    expect(picks.map((b) => b.title)).toEqual(['Hero', 'Features', 'Pricing']);
  });

  it('falls back to the first 60 chars of text when a block has no title', () => {
    const blocks = [{ y: 0, h: 500, text: 'Some long block text content', title: '', video: false }];

    const picks = pickSections(blocks, 8);

    expect(picks).toHaveLength(1);
  });

  it('returns every pick unchanged when there are fewer than maxN', () => {
    const blocks = [block('A'), block('B'), block('C')];

    expect(pickSections(blocks, 8)).toHaveLength(3);
  });

  it('spreads picks evenly by index when there are more than maxN, matching Python\'s round-half-to-even exactly', () => {
    // 10 distinct sections, maxN=3 -> round(i*9/2) for i=0,1,2 -> 0, 4.5, 9.
    // Confirmed directly in Python: round(4.5) == 4 (round-half-to-even),
    // not 5 — JS's Math.round(4.5) would give 5, which would pick a
    // different section than the source. This test is what caught that
    // discrepancy before it shipped; pageSections.ts's roundHalfToEven()
    // exists specifically to match this.
    const blocks = Array.from({ length: 10 }, (_, i) => block(`Section ${i}`));

    const picks = pickSections(blocks, 3);

    expect(picks.map((b) => b.title)).toEqual(['Section 0', 'Section 4', 'Section 9']);
  });

  it('returns only maxN picks (truncated) when maxN <= 1', () => {
    const blocks = [block('A'), block('B'), block('C')];

    expect(pickSections(blocks, 1)).toHaveLength(1);
    expect(pickSections(blocks, 1)[0].title).toBe('A');
  });

  it('returns an empty array for maxN=0', () => {
    expect(pickSections([block('A'), block('B')], 0)).toEqual([]);
  });
});

describe('libraryName', () => {
  it('builds clipNN_<slug>.mp4 from the section title', () => {
    expect(libraryName(1, 'Hero Section!!')).toBe('clip01_hero-section.mp4');
    expect(libraryName(12, 'Pricing')).toBe('clip12_pricing.mp4');
  });

  it('falls back to "section" when the title has no usable slug characters', () => {
    expect(libraryName(3, '!!!')).toBe('clip03_section.mp4');
  });

  it('truncates long titles to 32 slug characters', () => {
    const longTitle = 'This Is A Very Long Section Title That Goes On And On';
    const name = libraryName(1, longTitle);
    // "clip01_" (7) + up to 32 slug chars + ".mp4" (4)
    expect(name.length).toBeLessThanOrEqual(7 + 32 + 4);
    expect(name.startsWith('clip01_')).toBe(true);
  });
});

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric runs with a single hyphen, trimming edges', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('  --Leading/Trailing--  ')).toBe('leading-trailing');
  });
});

describe('shotClipName', () => {
  it('names a clip shot<NN>_<slug>.mp4, zero-padded', () => {
    expect(shotClipName(2, 'Dashboard Overview')).toBe('shot02_dashboard-overview.mp4');
  });

  it('falls back to "clip" when visualNeeded has no usable slug characters', () => {
    expect(shotClipName(5, '!!!')).toBe('shot05_clip.mp4');
  });

  it('falls back to "clip" when visualNeeded is empty', () => {
    expect(shotClipName(1, '')).toBe('shot01_clip.mp4');
  });

  it('truncates a long visualNeeded to 32 slug characters', () => {
    const name = shotClipName(10, 'This Is A Very Long Visual Description That Goes On And On');
    expect(name.startsWith('shot10_')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(7 + 32 + 4);
  });
});
