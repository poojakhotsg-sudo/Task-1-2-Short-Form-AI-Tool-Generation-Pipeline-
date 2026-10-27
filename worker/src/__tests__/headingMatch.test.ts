import { describe, it, expect } from 'vitest';
import { matchHeading, type PageHeading } from '../services/headingMatch.js';

function heading(text: string, hy = 0, overrides: Partial<PageHeading> = {}): PageHeading {
  return { text, tag: 'h2', hy, y: hy, h: 200, ...overrides };
}

describe('matchHeading', () => {
  it('returns null with a reason when there are no headings', () => {
    const result = matchHeading('some visual', []);
    expect(result.heading).toBeNull();
    expect(result.reason).toMatch(/no headings found/);
  });

  it('prefers a quoted phrase that a heading contains', () => {
    const headings = [heading('Meet your new creative partner'), heading("Visual storytelling without limits", 500)];
    const result = matchHeading("Shows the 'Visual storytelling without limits' section", headings);
    expect(result.heading?.text).toBe('Visual storytelling without limits');
  });

  it('matches by longest run of 3+ consecutive shared words when no quoted phrase matches', () => {
    const headings = [heading('Unrelated heading entirely'), heading('Meet your new creative partner')];
    const result = matchHeading('Meet your new creative partner section walkthrough', headings);
    expect(result.heading?.text).toBe('Meet your new creative partner');
    expect(result.wordsMatched).toBeGreaterThanOrEqual(3);
  });

  it('matches a short heading entirely even with only 2 shared words, if that covers the whole heading', () => {
    const headings = [heading('Export now')];
    const result = matchHeading('then you can export now from the dashboard', headings);
    expect(result.heading?.text).toBe('Export now');
  });

  it('does not match when fewer than 3 words run consecutively and the heading is longer than 2 words', () => {
    const headings = [heading('A totally different page section about billing')];
    const result = matchHeading('export your deck to pdf', headings);
    expect(result.heading).toBeNull();
    expect(result.reason).toMatch(/no heading on the page shares/);
  });

  it('prefers the heading higher up the page when runs tie', () => {
    const headings = [heading('Export your deck now', 800), heading('Export your deck now', 100)];
    const result = matchHeading('export your deck now please', headings);
    expect(result.heading?.hy).toBe(100);
  });
});
