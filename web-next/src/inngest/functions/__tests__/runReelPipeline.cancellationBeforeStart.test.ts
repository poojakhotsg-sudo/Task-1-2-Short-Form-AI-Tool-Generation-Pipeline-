import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, createFakeSupabaseClient, type FakeDb } from '@/test/fakeSupabase';
import { createFakeSweepContext } from '@/test/fakeStepContext';

let db: FakeDb;

vi.mock('@/lib/supabase', () => ({
  getSupabaseServerClient: () => createFakeSupabaseClient(db, {}),
}));

const { callWorkerTaskMock } = vi.hoisted(() => ({ callWorkerTaskMock: vi.fn() }));
vi.mock('@/lib/workerClient', () => ({ callWorkerTask: callWorkerTaskMock }));

import { runReelPipelineHandler } from '@/inngest/functions/runReelPipeline';
import type { Stage } from '@/inngest/functions/stageGraph';

function makeEvent(stages: Stage[]) {
  return {
    data: { jobId: 'job1', toolSlug: 'demo', toolName: 'Demo', url: 'https://example.com', stages },
  };
}

function job() {
  return db.jobs.find((j) => j.id === 'job1')!;
}

beforeEach(() => {
  db = createFakeDb();
  callWorkerTaskMock.mockReset();
  callWorkerTaskMock.mockResolvedValue({ status: 'ok', message: 'ok' });
});

describe("runReelPipelineHandler — cancellation-before-start fix", () => {
  // This is the exact regression the fix addresses: a stop request
  // arriving in the window between job creation (status: 'queued') and
  // this function actually starting. Before the fix, 'mark-job-running'
  // ran unconditionally first and silently clobbered 'stopping' back to
  // 'running', so the per-stage checks later in the loop never got a
  // chance to see the stop signal at all.
  it("never calls 'mark-job-running' when the job is already 'stopping' at the very first check", async () => {
    db.jobs.push({ id: 'job1', tool_slug: 'demo', status: 'stopping' });
    const stepLog: string[] = [];

    await runReelPipelineHandler({ event: makeEvent(['grab', 'describe']), ...createFakeSweepContext(stepLog) });

    expect(stepLog).toContain('check-cancelled-at-start');
    expect(stepLog).not.toContain('mark-job-running');
    expect(stepLog).toContain('mark-job-stopped-before-start');
  });

  it("sets the job to 'stopped' with finished_at, and never sets started_at (since 'running' was never entered)", async () => {
    db.jobs.push({ id: 'job1', tool_slug: 'demo', status: 'stopping' });

    await runReelPipelineHandler({ event: makeEvent(['grab']), ...createFakeSweepContext() });

    expect(job().status).toBe('stopped');
    expect(job().finished_at).toBeTruthy();
    expect(job().started_at).toBeUndefined();
  });

  it('creates zero job_stages rows — no stage is attempted, not even the first requested one', async () => {
    db.jobs.push({ id: 'job1', tool_slug: 'demo', status: 'stopping' });

    await runReelPipelineHandler({ event: makeEvent(['grab', 'describe', 'qa']), ...createFakeSweepContext() });

    expect(db.job_stages).toHaveLength(0);
  });

  it('never dispatches to the worker at all when stopped before start, regardless of how many worker-backed stages were requested', async () => {
    db.jobs.push({ id: 'job1', tool_slug: 'demo', status: 'stopping' });

    await runReelPipelineHandler({
      event: makeEvent(['grab', 'describe', 'qa', 'assemble', 'upload']),
      ...createFakeSweepContext(),
    });

    expect(callWorkerTaskMock).not.toHaveBeenCalled();
  });

  it("returns { status: 'stopped' } with an empty outcomes map, not partial progress", async () => {
    db.jobs.push({ id: 'job1', tool_slug: 'demo', status: 'stopping' });

    const result = await runReelPipelineHandler({ event: makeEvent(['grab', 'describe']), ...createFakeSweepContext() });

    expect(result).toEqual({ status: 'stopped', outcomes: {} });
  });

  // Control case: confirms the check itself isn't just a no-op gate —
  // it correctly lets a normal run proceed, and does so in the right
  // order (the check still runs first, it just returns false).
  it("runs 'check-cancelled-at-start' before 'mark-job-running' even in the normal (not stopping) path", async () => {
    db.jobs.push({ id: 'job1', tool_slug: 'demo', status: 'queued' });
    const stepLog: string[] = [];

    await runReelPipelineHandler({ event: makeEvent(['grab']), ...createFakeSweepContext(stepLog) });

    const checkIdx = stepLog.indexOf('check-cancelled-at-start');
    const runningIdx = stepLog.indexOf('mark-job-running');
    expect(checkIdx).toBeGreaterThanOrEqual(0);
    expect(runningIdx).toBeGreaterThan(checkIdx);
    expect(job().status).not.toBe('stopped');
  });

  it("does not treat any status other than exactly 'stopping' as a stop signal (e.g. 'queued', 'failed', 'done')", async () => {
    for (const status of ['queued', 'failed', 'done', 'running']) {
      db = createFakeDb();
      db.jobs.push({ id: 'job1', tool_slug: 'demo', status });
      const stepLog: string[] = [];

      await runReelPipelineHandler({ event: makeEvent(['grab']), ...createFakeSweepContext(stepLog) });

      expect(stepLog).toContain('mark-job-running');
    }
  });
});
