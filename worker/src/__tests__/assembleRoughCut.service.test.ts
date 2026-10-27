import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storageMocks, ffmpegMocks } = vi.hoisted(() => ({
  storageMocks: { downloadObject: vi.fn(), uploadObject: vi.fn() },
  ffmpegMocks: { probeVideo: vi.fn(), runFfmpeg: vi.fn() },
}));

vi.mock('../lib/storage.js', () => storageMocks);
vi.mock('../lib/ffmpeg.js', () => ffmpegMocks);
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    mkdtemp: vi.fn().mockResolvedValue('/tmp/fake-assemble-dir'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('fake-rough-cut-bytes')),
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

import { assembleRoughCut, type MatchResult } from '../services/assembleRoughCut.js';

function matchResult(shots: MatchResult['shots']): MatchResult {
  return { shots };
}

const MATCH_PREFIX = 'private/tools/demo/jobs/job1/match/';
const ASSEMBLE_PREFIX = 'private/tools/demo/jobs/job1/assemble/';

beforeEach(() => {
  Object.values(storageMocks).forEach((m) => m.mockReset());
  Object.values(ffmpegMocks).forEach((m) => m.mockReset());
  storageMocks.uploadObject.mockResolvedValue(undefined);
  ffmpegMocks.runFfmpeg.mockResolvedValue(undefined);
});

describe('assembleRoughCut', () => {
  it('throws when match_result.json does not exist — assemble cannot proceed without it', async () => {
    storageMocks.downloadObject.mockResolvedValue(null);

    await expect(assembleRoughCut('Demo', MATCH_PREFIX, ASSEMBLE_PREFIX)).rejects.toThrow(
      /match_result\.json not found/
    );
  });

  it('trims a covered shot to its target duration and uploads rough_cut.mp4', async () => {
    storageMocks.downloadObject.mockImplementation((key: string) => {
      if (key.endsWith('match_result.json')) {
        return Promise.resolve(
          Buffer.from(
            JSON.stringify(
              matchResult([
                { shot: 1, label: 'HOOK', scriptLine: 'x', source: 'website', file: 'clips/a.mp4', status: 'ok', durationSeconds: 5 },
              ])
            )
          )
        );
      }
      if (key === 'clips/a.mp4') return Promise.resolve(Buffer.from('fake-clip-bytes'));
      return Promise.resolve(null);
    });
    ffmpegMocks.probeVideo.mockResolvedValue({ seconds: 5, width: 1080, height: 1920 });

    const result = await assembleRoughCut('Demo', MATCH_PREFIX, ASSEMBLE_PREFIX);

    expect(result.roughCutUploaded).toBe(true);
    expect(result.shotsCovered).toBe(1);
    expect(result.shotsMissing).toBe(0);

    expect(storageMocks.uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({ key: `${ASSEMBLE_PREFIX}rough_cut.mp4`, contentType: 'video/mp4' })
    );
    expect(storageMocks.uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({ key: `${ASSEMBLE_PREFIX}summary.md`, contentType: 'text/markdown' })
    );
  });

  it('generates a placeholder for a missing shot when placeholders is true (default)', async () => {
    storageMocks.downloadObject.mockImplementation((key: string) => {
      if (key.endsWith('match_result.json')) {
        return Promise.resolve(
          Buffer.from(
            JSON.stringify(
              matchResult([
                { shot: 1, label: 'HOOK', scriptLine: 'x', source: 'website', file: null, status: 'missing', durationSeconds: 4 },
              ])
            )
          )
        );
      }
      return Promise.resolve(null);
    });

    const result = await assembleRoughCut('Demo', MATCH_PREFIX, ASSEMBLE_PREFIX, true);

    expect(result.roughCutUploaded).toBe(true); // a placeholder still counts as a cuttable part
    expect(result.shotsMissing).toBe(1);
    // runFfmpeg called for the placeholder color-source generation and the final concat.
    expect(ffmpegMocks.runFfmpeg).toHaveBeenCalled();
  });

  it('leaves a missing shot out entirely when placeholders is false, and produces no rough cut if that is the only shot', async () => {
    storageMocks.downloadObject.mockImplementation((key: string) => {
      if (key.endsWith('match_result.json')) {
        return Promise.resolve(
          Buffer.from(
            JSON.stringify(
              matchResult([
                { shot: 1, label: 'HOOK', scriptLine: 'x', source: 'website', file: null, status: 'missing', durationSeconds: 4 },
              ])
            )
          )
        );
      }
      return Promise.resolve(null);
    });

    const result = await assembleRoughCut('Demo', MATCH_PREFIX, ASSEMBLE_PREFIX, false);

    expect(result.roughCutUploaded).toBe(false);
    expect(storageMocks.uploadObject).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: `${ASSEMBLE_PREFIX}rough_cut.mp4` })
    );
    // summary.md is still written even when there's nothing to cut.
    expect(storageMocks.uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({ key: `${ASSEMBLE_PREFIX}summary.md` })
    );
  });

  it('never attempts to trim a needs_trial shot — it goes straight to left-out/placeholder handling', async () => {
    storageMocks.downloadObject.mockImplementation((key: string) => {
      if (key.endsWith('match_result.json')) {
        return Promise.resolve(
          Buffer.from(
            JSON.stringify(
              matchResult([
                { shot: 1, label: 'PROOF', scriptLine: 'x', source: 'trial', file: null, status: 'needs_trial', durationSeconds: 6 },
              ])
            )
          )
        );
      }
      return Promise.resolve(null);
    });

    const result = await assembleRoughCut('Demo', MATCH_PREFIX, ASSEMBLE_PREFIX, true);

    expect(result.shotsNeedTrial).toBe(1);
    expect(result.shotsCovered).toBe(0);
    // A placeholder was generated for it (needs_trial has no clip, so it
    // falls into the placeholder branch), not a trim attempt.
    expect(storageMocks.downloadObject).not.toHaveBeenCalledWith(null);
  });
});
