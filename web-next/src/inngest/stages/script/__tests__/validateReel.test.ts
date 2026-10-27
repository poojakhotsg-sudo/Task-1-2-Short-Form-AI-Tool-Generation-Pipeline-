import { describe, it, expect } from 'vitest';
import { validateReel } from '../validateReel';

function baseShots() {
  return [
    { shot: 1, script_line: 'Hook line', source: 'website', duration_seconds: 10, clip_file: 'hook.mp4' },
    { shot: 2, script_line: 'Body line', source: 'website', duration_seconds: 15, clip_file: 'body.mp4' },
    { shot: 3, script_line: 'CTA line', source: 'website', duration_seconds: 10, clip_file: 'cta.mp4' },
  ];
}

function validReel(overrides: Partial<{ shots: unknown[] }> = {}) {
  return { angle: 'use_case', angle_summary: 'a summary', shots: baseShots(), ...overrides };
}

describe('validateReel', () => {
  it('accepts a well-formed reel and fills visual_needed/trial_steps defaults', () => {
    const { reel, errors } = validateReel(validReel());
    expect(errors).toEqual([]);
    expect(reel).not.toBeNull();
    expect(reel!.shots[0].visual_needed).toBe('hook.mp4');
  });

  it('rejects fewer than 3 shots', () => {
    const { reel, errors } = validateReel({
      angle: 'use_case',
      angle_summary: 'x',
      shots: baseShots().slice(0, 2),
    });
    expect(reel).toBeNull();
    expect(errors.some((e) => /need at least 3/.test(e))).toBe(true);
  });

  it('rejects shot numbers that are not 1, 2, 3... in order', () => {
    const shots = baseShots();
    shots[1].shot = 5;
    const { errors } = validateReel({ angle: 'use_case', angle_summary: 'x', shots });
    expect(errors.some((e) => /run 1, 2, 3/.test(e))).toBe(true);
  });

  it('rejects a total duration outside 30-45s', () => {
    const shots = baseShots().map((s) => ({ ...s, duration_seconds: 1 })); // 3s total
    const { errors } = validateReel({ angle: 'use_case', angle_summary: 'x', shots });
    expect(errors.some((e) => /total duration/.test(e))).toBe(true);
  });

  it('rejects more than 2 trial shots', () => {
    const shots = [
      { shot: 1, script_line: 'a', source: 'trial', duration_seconds: 10, trial_steps: ['do a thing'] },
      { shot: 2, script_line: 'b', source: 'trial', duration_seconds: 10, trial_steps: ['do a thing'] },
      { shot: 3, script_line: 'c', source: 'trial', duration_seconds: 10, trial_steps: ['do a thing'] },
      { shot: 4, script_line: 'd', source: 'website', duration_seconds: 10, clip_file: 'x.mp4' },
    ];
    const { errors } = validateReel({ angle: 'use_case', angle_summary: 'x', shots });
    expect(errors.some((e) => /maximum allowed is 2/.test(e))).toBe(true);
  });

  it('rejects an individual shot duration outside 1-15s', () => {
    const shots = baseShots();
    shots[0].duration_seconds = 20;
    const { errors } = validateReel({ angle: 'use_case', angle_summary: 'x', shots });
    expect(errors.some((e) => /must be 1-15s/.test(e))).toBe(true);
  });

  it('rejects an empty script_line', () => {
    const shots = baseShots();
    shots[0].script_line = '   ';
    const { errors } = validateReel({ angle: 'use_case', angle_summary: 'x', shots });
    expect(errors.some((e) => /script_line must not be empty/.test(e))).toBe(true);
  });

  it('defaults visual_needed from the script line when empty and no clip_file', () => {
    const shots = baseShots();
    shots[0] = { ...shots[0], clip_file: undefined as unknown as string, script_line: 'a fairly long demo line about the product' };
    const { reel } = validateReel({ angle: 'use_case', angle_summary: 'x', shots });
    expect(reel!.shots[0].visual_needed).toBe('demo of a fairly long demo line about ');
  });

  it('defaults trial_steps for a trial shot with none given', () => {
    const shots = [
      { shot: 1, script_line: 'a', source: 'website', duration_seconds: 10, clip_file: 'a.mp4' },
      { shot: 2, script_line: 'b', source: 'trial', duration_seconds: 10 },
      { shot: 3, script_line: 'c', source: 'website', duration_seconds: 10, clip_file: 'c.mp4' },
    ];
    const { reel } = validateReel({ angle: 'use_case', angle_summary: 'x', shots });
    expect(reel!.shots[1].trial_steps).toEqual(['Demonstrate feature inside tool']);
  });

  it('force-clears trial_steps on a website-sourced shot', () => {
    const shots = baseShots();
    shots[0] = { ...shots[0], trial_steps: ['some leftover step'] } as never;
    const { reel } = validateReel({ angle: 'use_case', angle_summary: 'x', shots });
    expect(reel!.shots[0].trial_steps).toEqual([]);
  });

  it('rejects a trial step mentioning login/payment details', () => {
    const shots = [
      { shot: 1, script_line: 'a', source: 'website', duration_seconds: 10, clip_file: 'a.mp4' },
      { shot: 2, script_line: 'b', source: 'trial', duration_seconds: 10, trial_steps: ['enter your credit card number'] },
      { shot: 3, script_line: 'c', source: 'website', duration_seconds: 10, clip_file: 'c.mp4' },
    ];
    const { errors } = validateReel({ angle: 'use_case', angle_summary: 'x', shots });
    expect(errors.some((e) => /login\/payment details/.test(e))).toBe(true);
  });

  it('rejects malformed input that fails basic schema validation', () => {
    const { reel, errors } = validateReel({ angle: 'not_a_real_angle', shots: [] });
    expect(reel).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });
});
