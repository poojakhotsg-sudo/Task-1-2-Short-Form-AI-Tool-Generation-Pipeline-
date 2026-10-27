import { describe, it, expect } from 'vitest';
import { parseScript, buildShots, clipName, type Shot } from '@/inngest/stages/match/scriptParser';

describe('parseScript', () => {
  it('labels the first segment HOOK and the last CTA when headers are free-form (not in KEEP_LABELS)', () => {
    // "INTRO" would NOT work here — it's one of KEEP_LABELS (HOOK, PROOF,
    // CTA, INTRO, OUTRO, DEMO, RESULT) and is kept as-is regardless of
    // position, taking precedence over the positional HOOK/CTA fallback.
    const script = `[0-4s] GETTING STARTED
First line of the hook.

[20-25s] WRAP UP
Closing line.`;
    const segments = parseScript(script);

    expect(segments[0].label).toBe('HOOK');
    expect(segments[segments.length - 1].label).toBe('CTA');
  });

  it('keeps an explicit KEEP_LABELS header as-is even in first/last position, overriding the positional HOOK/CTA fallback', () => {
    const script = `[0-4s] INTRO
intro line.

[20-25s] OUTRO
outro line.`;
    const segments = parseScript(script);

    expect(segments.map((s) => s.label)).toEqual(['INTRO', 'OUTRO']);
  });

  it('recognizes STEP/FEATURE/PART headers as explicit STEP n labels', () => {
    const script = `[0-4s] HOOK
hook line.

[4-10s] FEATURE 1 - Prompt to deck
One: type what you need.

[10-16s] FEATURE 2 - Export
Two: export it.

[16-20s] CTA
Go try it.`;
    const segments = parseScript(script);

    expect(segments.map((s) => s.label)).toEqual(['HOOK', 'STEP 1', 'STEP 2', 'CTA']);
    expect(segments[1].title).toBe('Prompt to deck');
  });

  it('labels a middle segment PROOF when it carries a trial-hint phrase, even with a free-form header', () => {
    const script = `[0-4s] HOOK
hook line.

[4-14s] WATCH THIS
Here's what it built for me in 10 seconds.

[14-18s] CTA
Go try it.`;
    const segments = parseScript(script);

    expect(segments[1].label).toBe('PROOF');
    expect(segments[1].source).toBe('trial');
  });

  it('respects an explicit (website)/(trial) source marker and strips it from the header text', () => {
    const script = `[0-4s] HOOK (trial)
hook line.`;
    const segments = parseScript(script);

    expect(segments[0].source).toBe('trial');
    expect(segments[0].sourceGiven).toBe(true);
  });

  it('a single segment with no other segments is HOOK, not CTA (CTA requires more than one segment)', () => {
    const script = `[0-4s] ONLY ONE
just this.`;
    const segments = parseScript(script);

    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe('HOOK');
  });

  it('keeps an explicit KEEP_LABELS header (e.g. PROOF) as-is and syncs the step counter from an explicit STEP n', () => {
    const script = `[0-4s] HOOK
hook.

[4-10s] STEP 3
explicit step three.

[10-14s] PROOF
proof line.

[14-18s] STEP 4
should be step four, not step two.`;
    const segments = parseScript(script);

    expect(segments.map((s) => s.label)).toEqual(['HOOK', 'STEP 3', 'PROOF', 'STEP 4']);
  });
});

describe('buildShots', () => {
  it('uses shot_list.json directly (asset-first format) when it is a non-empty list, ignoring segments entirely', () => {
    const segments = parseScript('[0-4s] HOOK\nhook.');
    const shotList = [
      { shot: 1, visual_needed: 'dashboard overview', duration_seconds: 6, source: 'website' as const },
      { shot: 2, visual_needed: 'export button click', clip_file: 'private/x/export.mp4', duration_seconds: 4 },
    ];

    const shots = buildShots(segments, shotList);

    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({ shot: 1, label: 'SHOT 1', visualNeeded: 'dashboard overview', durationSeconds: 6 });
    expect(shots[1].clipFile).toBe('private/x/export.mp4');
  });

  it('falls back to segments when shot_list is an empty array (Python falsy-empty-list semantics)', () => {
    const segments = parseScript(`[0-4s] HOOK
hook line.

[4-10s] CTA
go.`);

    const shots = buildShots(segments, []);

    expect(shots).toHaveLength(2);
    expect(shots[0].label).toBe('HOOK');
    expect(shots[0].scriptLine).toBe('hook line.');
  });

  it('a non-empty shot_list always takes the direct asset-first branch, even one that looks like per-segment alignment data', () => {
    // matcher.py's build_shots() gates the direct branch on
    // `if shot_list and isinstance(shot_list, list)` — true for ANY
    // non-empty list, with no per-element shape check. Confirmed this
    // directly in Python (`bool([{'source': 'trial'}])` -> True), not
    // just by reading the source. The practical consequence: the
    // per-segment "aligned" branch below (`extra?.clip_file` etc.) is
    // ported faithfully from the Python structure but is unreachable
    // through any non-empty shotList argument — it only runs when
    // shotList is omitted or an empty array, since a same-length
    // "partial" list still satisfies the direct branch's condition and
    // wins first. This is a property of the original pipeline, not
    // something introduced by porting it.
    const segments = parseScript(`[0-4s] HOOK
hook.

[4-10s] FEATURE 1 - Export
do the export.`);
    const partialList = [
      { visual_needed: 'intro visual' },
      { source: 'trial' as const, visual_needed: 'export demo', clip_file: 'private/x/export.mp4' },
    ];

    const shots = buildShots(segments, partialList);

    // Direct-branch field defaults apply, NOT the segments' own
    // label/title/scriptLine — e.g. label is "SHOT n", not "HOOK".
    expect(shots[0].label).toBe('SHOT 1');
    expect(shots[0].visualNeeded).toBe('intro visual');
    expect(shots[1].source).toBe('trial');
    expect(shots[1].clipFile).toBe('private/x/export.mp4');
  });

  it('only reaches the per-segment alignment branch when shot_list is omitted', () => {
    const segments = parseScript(`[0-4s] HOOK (website)
hook.`);

    const shots = buildShots(segments); // no shotList at all -> aligned is undefined, segments drive everything

    expect(shots[0].label).toBe('HOOK');
    expect(shots[0].source).toBe('website');
    expect(shots[0].clipFile).toBeNull();
  });
});

describe('clipName', () => {
  it('builds a deterministic shotNN_<slug>.mp4 name from visualNeeded, matching grabber.py exactly', () => {
    const shot: Shot = {
      shot: 3,
      label: 'STEP 3',
      title: '',
      start: 0,
      end: 5,
      time: '0-5s',
      durationSeconds: 5,
      scriptLine: '',
      source: 'website',
      clipFile: null,
      visualNeeded: 'Dashboard Overview!!',
      trialSteps: [],
      file: null,
      matchScore: 0,
    };

    expect(clipName(shot)).toBe('shot03_dashboard-overview.mp4');
  });

  it('falls back to "clip" when visualNeeded has no usable slug characters', () => {
    const shot: Shot = {
      shot: 1,
      label: 'HOOK',
      title: '',
      start: 0,
      end: 5,
      time: '0-5s',
      durationSeconds: 5,
      scriptLine: '',
      source: 'website',
      clipFile: null,
      visualNeeded: '!!!',
      trialSteps: [],
      file: null,
      matchScore: 0,
    };

    expect(clipName(shot)).toBe('shot01_clip.mp4');
  });
});
