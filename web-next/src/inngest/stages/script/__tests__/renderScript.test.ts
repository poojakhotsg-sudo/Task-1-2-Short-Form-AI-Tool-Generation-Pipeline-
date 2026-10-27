import { describe, it, expect } from 'vitest';
import { renderScript } from '../renderScript';
import type { Reel } from '../schema';

function reel(overrides: Partial<Reel> = {}): Reel {
  return {
    angle: 'use_case',
    angle_summary: 'shows the export flow end to end',
    shots: [
      { shot: 1, time: '', duration_seconds: 5, script_line: 'Hook line', clip_file: 'hook.mp4', source: 'website', visual_needed: 'hook', trial_steps: [] },
      { shot: 2, time: '', duration_seconds: 10, script_line: 'Proof line', clip_file: null, source: 'trial', visual_needed: 'proof', trial_steps: ['do the thing'] },
      { shot: 3, time: '', duration_seconds: 5, script_line: 'CTA line', clip_file: 'cta.mp4', source: 'website', visual_needed: 'cta', trial_steps: [] },
    ],
    ...overrides,
  };
}

describe('renderScript', () => {
  it('labels the first shot HOOK, the last CTA, and a trial shot PROOF', () => {
    const text = renderScript('demo', 'https://example.com', reel());
    expect(text).toMatch(/HOOK - hook \(hook\.mp4\)/);
    expect(text).toMatch(/PROOF - proof \(trial\)/);
    expect(text).toMatch(/CTA - cta \(cta\.mp4\)/);
  });

  it('labels middle website shots STEP n sequentially', () => {
    const r = reel({
      shots: [
        { shot: 1, time: '', duration_seconds: 5, script_line: 'a', clip_file: 'a.mp4', source: 'website', visual_needed: 'a', trial_steps: [] },
        { shot: 2, time: '', duration_seconds: 5, script_line: 'b', clip_file: 'b.mp4', source: 'website', visual_needed: 'b', trial_steps: [] },
        { shot: 3, time: '', duration_seconds: 5, script_line: 'c', clip_file: 'c.mp4', source: 'website', visual_needed: 'c', trial_steps: [] },
        { shot: 4, time: '', duration_seconds: 5, script_line: 'd', clip_file: 'd.mp4', source: 'website', visual_needed: 'd', trial_steps: [] },
      ],
    });
    const text = renderScript('demo', 'https://example.com', r);
    expect(text).toMatch(/STEP 1 - b/);
    expect(text).toMatch(/STEP 2 - c/);
  });

  it('includes the tool name, angle, and total duration in the header', () => {
    const text = renderScript('demo', 'https://example.com', reel());
    expect(text).toMatch(/^DEMO - 20s reel script/);
    expect(text).toMatch(/Angle: 1 full use case - shows the export flow end to end/);
  });

  it('renders timestamps accumulating across shots', () => {
    const text = renderScript('demo', 'https://example.com', reel());
    expect(text).toMatch(/\[0-5s\]/);
    expect(text).toMatch(/\[5-15s\]/);
    expect(text).toMatch(/\[15-20s\]/);
  });

  it('truncates a long visual_needed to 60 characters', () => {
    const r = reel();
    r.shots[0].visual_needed = 'x'.repeat(100);
    const text = renderScript('demo', 'https://example.com', r);
    expect(text).toContain('x'.repeat(60) + ' (hook.mp4)');
    expect(text).not.toContain('x'.repeat(61));
  });
});
