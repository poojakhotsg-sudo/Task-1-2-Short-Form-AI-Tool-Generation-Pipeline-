import { describe, it, expect } from 'vitest';
import { STAGE_ORDER, STAGE_DEPENDENCIES, unmetPrerequisite } from '@/inngest/functions/stageGraph';

describe('stageGraph', () => {
  it('STAGE_ORDER is a valid topological order of STAGE_DEPENDENCIES', () => {
    const position = new Map(STAGE_ORDER.map((s, i) => [s, i]));
    for (const stage of STAGE_ORDER) {
      for (const dep of STAGE_DEPENDENCIES[stage]) {
        expect(position.get(dep)).toBeLessThan(position.get(stage)!);
      }
    }
  });

  it('matches PIPE-01\'s documented dependencies exactly', () => {
    expect(STAGE_DEPENDENCIES).toEqual({
      grab: [],
      describe: ['grab'],
      script: [],
      match: ['grab', 'script'],
      qa: ['match'],
      trial: ['match'],
      assemble: ['match'],
      upload: ['assemble'],
    });
  });

  describe('unmetPrerequisite', () => {
    it('returns null when every prerequisite is done', () => {
      expect(unmetPrerequisite('match', { grab: 'done', script: 'done' })).toBeNull();
    });

    it('returns the first unmet prerequisite when one failed', () => {
      expect(unmetPrerequisite('match', { grab: 'done', script: 'failed' })).toBe('script');
    });

    it('returns the first unmet prerequisite when one was skipped', () => {
      expect(unmetPrerequisite('match', { grab: 'skipped', script: 'done' })).toBe('grab');
    });

    it('treats a prerequisite with no recorded outcome as unmet', () => {
      expect(unmetPrerequisite('describe', {})).toBe('grab');
    });

    it('returns null for a stage with no prerequisites', () => {
      expect(unmetPrerequisite('grab', {})).toBeNull();
      expect(unmetPrerequisite('script', {})).toBeNull();
    });
  });
});
