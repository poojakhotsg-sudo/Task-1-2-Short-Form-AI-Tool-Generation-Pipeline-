import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeStorageBucket, createFakeSupabaseClient, createFakeDb, setFakeBucketObject, type FakeBucket } from '@/test/fakeSupabase';

let privateBucket: FakeBucket;

vi.mock('@/lib/supabase', () => ({
  getSupabaseServerClient: () => createFakeSupabaseClient(createFakeDb(), { 'reel-private': privateBucket }),
}));

const { scoreCatalogAgainstLineMock, callWorkerTaskMock } = vi.hoisted(() => ({
  scoreCatalogAgainstLineMock: vi.fn(),
  callWorkerTaskMock: vi.fn(),
}));
vi.mock('@/inngest/stages/match/clipScoring', () => ({ scoreCatalogAgainstLine: scoreCatalogAgainstLineMock }));
vi.mock('@/lib/workerClient', () => ({ callWorkerTask: callWorkerTaskMock }));

import { runMatchStage } from '@/inngest/stages/match';

const CTX = { jobId: 'job1', toolSlug: 'demo', toolName: 'Demo', url: 'https://example.com' };
const SCRIPT_PREFIX = 'private/tools/demo/jobs/job1/script/';
const GRAB_PREFIX = 'private/tools/demo/jobs/job1/grab/';
const MATCH_PREFIX = 'private/tools/demo/jobs/job1/match/';

beforeEach(() => {
  process.env.OBJECT_STORAGE_PRIVATE_BUCKET = 'reel-private';
  privateBucket = createFakeStorageBucket();
  scoreCatalogAgainstLineMock.mockReset();
  scoreCatalogAgainstLineMock.mockResolvedValue({});
  callWorkerTaskMock.mockReset();
});

function seedShotList(shots: object[]) {
  setFakeBucketObject(privateBucket, `${SCRIPT_PREFIX}shot_list.json`, {
    updatedAt: new Date().toISOString(),
    content: JSON.stringify(shots),
  });
}

describe('runMatchStage: record_missing_shot_clips fallback', () => {
  it('calls the worker with every still-unmatched website shot, and does not call it when everything already matched', async () => {
    seedShotList([{ shot: 1, visual_needed: 'export flow', script_line: 'then export', duration_seconds: 5 }]);
    callWorkerTaskMock.mockResolvedValue({ status: 'ok', data: { shots: [] } });

    await runMatchStage(CTX);

    expect(callWorkerTaskMock).toHaveBeenCalledWith('record_missing_shot_clips', {
      jobId: 'job1',
      toolSlug: 'demo',
      url: 'https://example.com',
      storagePrefix: GRAB_PREFIX,
      headed: false,
      shots: [{ shot: 1, visualNeeded: 'export flow', scriptLine: 'then export', durationSeconds: 5 }],
    });
  });

  it('does not call the worker when every shot already matched via Rules 1/1b/2', async () => {
    seedShotList([{ shot: 1, visual_needed: 'x', clip_file: `${GRAB_PREFIX}clips/hero.mp4`, duration_seconds: 5 }]);
    setFakeBucketObject(privateBucket, `${GRAB_PREFIX}clips/hero.mp4`, { updatedAt: new Date().toISOString() });

    await runMatchStage(CTX);

    expect(callWorkerTaskMock).not.toHaveBeenCalled();
  });

  it('does not call the worker for a trial shot that has no clip', async () => {
    seedShotList([{ shot: 1, visual_needed: 'x', source: 'trial', duration_seconds: 5 }]);

    await runMatchStage(CTX);

    expect(callWorkerTaskMock).not.toHaveBeenCalled();
  });

  it('upgrades a shot to "ok" with matchType "mobile_recording" when the worker recorded a clip for it', async () => {
    seedShotList([{ shot: 1, visual_needed: 'export flow', script_line: 'then export', duration_seconds: 5 }]);
    callWorkerTaskMock.mockResolvedValue({
      status: 'ok',
      data: {
        shots: [{ shot: 1, file: `${GRAB_PREFIX}clips/shot01_export-flow.mp4`, status: 'ok', error: null }],
      },
    });

    const result = await runMatchStage(CTX);

    const matchResult = JSON.parse(privateBucket.get(`${MATCH_PREFIX}match_result.json`)!.content!);
    expect(matchResult.shots[0]).toMatchObject({
      file: `${GRAB_PREFIX}clips/shot01_export-flow.mp4`,
      status: 'ok',
      matchScore: 1.0,
      matchType: 'mobile_recording',
    });
    expect(matchResult.shots[0].error).toBeUndefined();
    expect(result.data?.matchedCount).toBe(1);
  });

  it('keeps a shot "missing" with the worker-reported reason when the worker could not record it', async () => {
    seedShotList([{ shot: 1, visual_needed: 'export flow', script_line: 'then export', duration_seconds: 5 }]);
    callWorkerTaskMock.mockResolvedValue({
      status: 'ok',
      data: {
        shots: [{ shot: 1, file: null, status: 'missing', error: "insufficient website assets for visual: 'export flow' (no matching heading)" }],
      },
    });

    await runMatchStage(CTX);

    const matchResult = JSON.parse(privateBucket.get(`${MATCH_PREFIX}match_result.json`)!.content!);
    expect(matchResult.shots[0]).toMatchObject({ file: null, status: 'missing' });
    expect(matchResult.shots[0].error).toMatch(/no matching heading/);
  });

  it('keeps shots missing with their original reason when the worker call fails, without aborting the stage', async () => {
    seedShotList([{ shot: 1, visual_needed: 'export flow', script_line: 'then export', duration_seconds: 5 }]);
    callWorkerTaskMock.mockRejectedValue(new Error('WORKER_BASE_URL is not configured'));

    const result = await runMatchStage(CTX);

    const matchResult = JSON.parse(privateBucket.get(`${MATCH_PREFIX}match_result.json`)!.content!);
    expect(matchResult.shots[0]).toMatchObject({ file: null, status: 'missing' });
    expect(matchResult.shots[0].error).toMatch(/insufficient website assets/);
    expect(result.data?.matchedCount).toBe(0);
  });

  it('keeps shots missing with their original reason when the worker reports a task-level error', async () => {
    seedShotList([{ shot: 1, visual_needed: 'export flow', script_line: 'then export', duration_seconds: 5 }]);
    callWorkerTaskMock.mockResolvedValue({ status: 'error', message: 'browser crashed' });

    const result = await runMatchStage(CTX);

    const matchResult = JSON.parse(privateBucket.get(`${MATCH_PREFIX}match_result.json`)!.content!);
    expect(matchResult.shots[0]).toMatchObject({ file: null, status: 'missing' });
    expect(result.data?.matchedCount).toBe(0);
  });

  it('only sends the still-unmatched shots to the worker, not ones Rule 2 already matched', async () => {
    seedShotList([
      { shot: 1, visual_needed: 'a', script_line: 'line a', duration_seconds: 5 },
      { shot: 2, visual_needed: 'b', script_line: 'line b', duration_seconds: 5 },
    ]);
    setFakeBucketObject(privateBucket, `${GRAB_PREFIX.replace('grab', 'describe')}clip_catalog.json`, {
      updatedAt: new Date().toISOString(),
      content: JSON.stringify({ 'only.mp4': { caption: 'x', tags: [], has_ui: true, clip_type: 'ui' } }),
    });
    scoreCatalogAgainstLineMock.mockResolvedValue({ 'only.mp4': 0.9 });
    callWorkerTaskMock.mockResolvedValue({ status: 'ok', data: { shots: [] } });

    await runMatchStage(CTX);

    expect(callWorkerTaskMock).toHaveBeenCalledWith(
      'record_missing_shot_clips',
      expect.objectContaining({ shots: [{ shot: 2, visualNeeded: 'b', scriptLine: 'line b', durationSeconds: 5 }] })
    );
  });
});
