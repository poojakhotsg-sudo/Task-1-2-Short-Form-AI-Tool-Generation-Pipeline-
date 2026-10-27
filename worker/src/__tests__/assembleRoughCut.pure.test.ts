import { describe, it, expect } from 'vitest';
import { classifyShot, renderSummary, type MatchedShot } from '../services/assembleRoughCut.js';

function shot(overrides: Partial<MatchedShot>): MatchedShot {
  return {
    shot: 1,
    label: 'HOOK',
    scriptLine: 'line',
    source: 'website',
    file: null,
    status: 'missing',
    durationSeconds: 5,
    ...overrides,
  };
}

describe('classifyShot', () => {
  it('classifies a shot with a file as covered', () => {
    expect(classifyShot(shot({ status: 'ok', file: 'clips/a.mp4' }))).toEqual({ kind: 'covered', hasClip: true });
  });

  it('classifies a shot with no file as missing, even if status is "ok"', () => {
    // Defensive: trust file presence over the status label, same as the
    // Python source trusting `bool(file) and file.exists()` over any
    // status field.
    expect(classifyShot(shot({ status: 'ok', file: null }))).toEqual({ kind: 'missing', hasClip: false });
  });

  it('classifies a needs_trial shot as needs_trial regardless of whether file happens to be set', () => {
    expect(classifyShot(shot({ status: 'needs_trial', file: null }))).toEqual({ kind: 'needs_trial', hasClip: false });
  });
});

describe('renderSummary', () => {
  const covered = shot({ shot: 1, status: 'ok', file: 'clips/a.mp4', scriptLine: 'hook line' });
  const missing = shot({ shot: 2, status: 'missing', scriptLine: 'missing line' });
  const needsTrial = shot({ shot: 3, status: 'needs_trial', source: 'trial', scriptLine: 'proof line' });

  it('reports the rough cut as made, with total duration and dimensions, when hasCut is true', () => {
    const rows = [{ shot: covered, kind: 'covered' as const, want: 5, start: 0, used: 'clip (5.0s)', note: '' }];
    const md = renderSummary('Demo', rows, 5, true);

    expect(md).toMatch(/# Demo rough cut/);
    // Matches Python's `f"{sec%60:04.1f}"` zero-padding exactly: 5s -> "05.0", not "5.0".
    expect(md).toMatch(/Rough cut: `rough_cut\.mp4` \(0:05\.0, 1080x1920\)/);
  });

  it('reports "not made" when hasCut is false', () => {
    const md = renderSummary('Demo', [], 0, false);
    expect(md).toMatch(/Rough cut: not made \(no shots to cut\)/);
  });

  it('groups rows into Covered / Missing / Needs trial sections with correct counts', () => {
    const rows = [
      { shot: covered, kind: 'covered' as const, want: 5, start: 0, used: 'clip (5.0s)', note: '' },
      { shot: missing, kind: 'missing' as const, want: 4, start: null, used: 'left out', note: '' },
      { shot: needsTrial, kind: 'needs_trial' as const, want: 6, start: null, used: 'left out', note: '' },
    ];
    const md = renderSummary('Demo', rows, 5, true);

    expect(md).toMatch(/Shots: 3 total, 1 covered, 1 missing, 1 needs trial/);
    expect(md).toMatch(/## Covered \(1\)/);
    expect(md).toMatch(/## Missing \(1\)/);
    expect(md).toMatch(/## Needs trial \(1\)/);
    expect(md).toMatch(/hook line/);
    expect(md).toMatch(/missing line/);
    expect(md).toMatch(/proof line/);
  });

  it('prints "None." for an empty group instead of an empty table', () => {
    const rows = [{ shot: covered, kind: 'covered' as const, want: 5, start: 0, used: 'clip (5.0s)', note: '' }];
    const md = renderSummary('Demo', rows, 5, true);

    const missingSection = md.split('## Missing')[1].split('## Needs trial')[0];
    expect(missingSection).toMatch(/None\./);
  });

  it('escapes pipe characters in the script line so they do not break the markdown table', () => {
    const withPipe = shot({ shot: 4, status: 'ok', file: 'clips/a.mp4', scriptLine: 'a | b' });
    const rows = [{ shot: withPipe, kind: 'covered' as const, want: 5, start: 0, used: 'clip (5.0s)', note: '' }];
    const md = renderSummary('Demo', rows, 5, true);

    expect(md).toMatch(/a \/ b/);
    expect(md).not.toMatch(/a \| b/);
  });
});
