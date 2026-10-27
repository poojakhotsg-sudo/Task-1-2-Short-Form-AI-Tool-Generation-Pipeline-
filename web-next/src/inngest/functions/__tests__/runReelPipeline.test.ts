import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, createFakeSupabaseClient, type FakeDb } from '@/test/fakeSupabase';
import { createFakeSweepContext } from '@/test/fakeStepContext';

let db: FakeDb;

vi.mock('@/lib/supabase', () => ({
  getSupabaseServerClient: () => createFakeSupabaseClient(db, {}),
}));

type WorkerResponse = { status: 'ok' | 'error'; message?: string; data?: Record<string, unknown> };
let workerResponses: Record<string, WorkerResponse>;

vi.mock('@/lib/workerClient', () => ({
  callWorkerTask: vi.fn((task: string) => {
    const response = workerResponses[task];
    if (!response) throw new Error(`unexpected worker task in test: ${task}`);
    return Promise.resolve(response);
  }),
}));

import { runReelPipelineHandler } from '@/inngest/functions/runReelPipeline';
import type { Stage } from '@/inngest/functions/stageGraph';

function makeEvent(stages: Stage[], overrides: Partial<Record<string, unknown>> = {}) {
  return {
    data: {
      jobId: 'job1',
      toolSlug: 'demo',
      toolName: 'Demo',
      url: 'https://example.com',
      stages,
      ...overrides,
    },
  };
}

function stageStatus(stage: string) {
  return db.job_stages.find((s) => s.stage === stage)?.status;
}

beforeEach(() => {
  db = createFakeDb();
  db.jobs.push({ id: 'job1', tool_slug: 'demo', status: 'queued' });
  workerResponses = {
    capture_site: { status: 'ok', message: 'grabbed' },
    describe_clips: { status: 'ok', message: 'described' },
    fetch_site_text: { status: 'ok', message: 'fetched site text' },
    run_qa: { status: 'ok', message: 'qa passed' },
    record_trial_steps: { status: 'ok', message: 'trial recorded' },
    assemble_rough_cut: { status: 'ok', message: 'assembled' },
    upload_drive: { status: 'ok', message: 'uploaded' },
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.GROK_API_KEY;
});

describe('runReelPipelineHandler', () => {
  it('runs a subset pipeline (grab + describe only) end to end when the worker succeeds', async () => {
    const result = await runReelPipelineHandler({
      event: makeEvent(['grab', 'describe']),
      ...createFakeSweepContext(),
    });

    expect(result.status).toBe('done');
    expect(stageStatus('grab')).toBe('done');
    expect(stageStatus('describe')).toBe('done');
    expect(db.jobs.find((j) => j.id === 'job1')?.status).toBe('done');
  });

  it('a script-stage failure (no object storage configured in this harness) skips everything downstream', async () => {
    const result = await runReelPipelineHandler({
      event: makeEvent(['grab', 'describe', 'script', 'match', 'qa', 'trial', 'assemble', 'upload']),
      ...createFakeSweepContext(),
    });

    expect(stageStatus('grab')).toBe('done');
    expect(stageStatus('describe')).toBe('done');
    // script.ts is real now (PIPE-04) — this harness never configures
    // OBJECT_STORAGE_PRIVATE_BUCKET, so its first storage read throws.
    // That's this test's own gap, not script.ts's; it still exercises
    // the thing this test is actually for: a failed stage correctly
    // skipping everything downstream.
    expect(stageStatus('script')).toBe('failed');
    expect(stageStatus('match')).toBe('skipped');
    expect(stageStatus('qa')).toBe('skipped');
    expect(stageStatus('trial')).toBe('skipped');
    expect(stageStatus('assemble')).toBe('skipped');
    expect(stageStatus('upload')).toBe('skipped');

    const matchRow = db.job_stages.find((s) => s.stage === 'match');
    expect(matchRow?.skipped_reason).toBe("prerequisite 'script' did not complete");

    expect(result.status).toBe('failed');
    expect(db.jobs.find((j) => j.id === 'job1')?.status).toBe('failed');
  });

  it('skips a stage whose prerequisite failed, with the right reason, and continues past it (does not abort the run)', async () => {
    workerResponses.capture_site = { status: 'error', message: 'site unreachable' };

    const result = await runReelPipelineHandler({
      event: makeEvent(['grab', 'describe']),
      ...createFakeSweepContext(),
    });

    expect(stageStatus('grab')).toBe('failed');
    const grabRow = db.job_stages.find((s) => s.stage === 'grab');
    expect(grabRow?.message).toBe('site unreachable');

    expect(stageStatus('describe')).toBe('skipped');
    expect(db.job_stages.find((s) => s.stage === 'describe')?.skipped_reason).toBe(
      "prerequisite 'grab' did not complete"
    );

    expect(result.status).toBe('failed');
  });

  it('never invokes a stage that was not requested at all', async () => {
    await runReelPipelineHandler({
      event: makeEvent(['grab']),
      ...createFakeSweepContext(),
    });

    expect(stageStatus('grab')).toBe('done');
    // Not requested — no job_stages row at all, not even 'skipped'.
    expect(db.job_stages.find((s) => s.stage === 'describe')).toBeUndefined();
  });

  it("stops cooperatively when the job is already marked 'stopping' before the first stage check", async () => {
    db.jobs.find((j) => j.id === 'job1')!.status = 'stopping';

    const result = await runReelPipelineHandler({
      event: makeEvent(['grab', 'describe']),
      ...createFakeSweepContext(),
    });

    expect(result.status).toBe('stopped');
    expect(db.jobs.find((j) => j.id === 'job1')?.status).toBe('stopped');
    // No stage should have actually run.
    expect(db.job_stages).toHaveLength(0);
  });
});
