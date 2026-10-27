import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeStorageBucket, createFakeSupabaseClient, setFakeBucketObject, type FakeBucket } from '@/test/fakeSupabase';
import { createFakeDb } from '@/test/fakeSupabase';

let privateBucket: FakeBucket;

vi.mock('@/lib/supabase', () => ({
  getSupabaseServerClient: () => createFakeSupabaseClient(createFakeDb(), { 'reel-private': privateBucket }),
}));

const { scoreCatalogAgainstLineMock } = vi.hoisted(() => ({ scoreCatalogAgainstLineMock: vi.fn() }));
vi.mock('@/inngest/stages/match/clipScoring', () => ({ scoreCatalogAgainstLine: scoreCatalogAgainstLineMock }));

import { runMatchStage } from '@/inngest/stages/match';

const CTX = { jobId: 'job1', toolSlug: 'demo', toolName: 'Demo', url: 'https://example.com' };
const SCRIPT_PREFIX = 'private/tools/demo/jobs/job1/script/';
const GRAB_PREFIX = 'private/tools/demo/jobs/job1/grab/';
const DESCRIBE_PREFIX = 'private/tools/demo/jobs/job1/describe/';
const MATCH_PREFIX = 'private/tools/demo/jobs/job1/match/';

beforeEach(() => {
  process.env.OBJECT_STORAGE_PRIVATE_BUCKET = 'reel-private';
  privateBucket = createFakeStorageBucket();
  scoreCatalogAgainstLineMock.mockReset();
  scoreCatalogAgainstLineMock.mockResolvedValue({});
});

function seedShotList(shots: object[]) {
  setFakeBucketObject(privateBucket, `${SCRIPT_PREFIX}shot_list.json`, {
    updatedAt: new Date().toISOString(),
    content: JSON.stringify(shots),
  });
}

function seedCatalog(catalog: object) {
  setFakeBucketObject(privateBucket, `${DESCRIBE_PREFIX}clip_catalog.json`, {
    updatedAt: new Date().toISOString(),
    content: JSON.stringify(catalog),
  });
}

describe('runMatchStage', () => {
  it('throws when shot_list.json does not exist — match cannot proceed without it', async () => {
    await expect(runMatchStage(CTX)).rejects.toThrow(/shot_list\.json not found/);
  });

  it('Rule 1: reuses a script-specified clip_file directly when it exists in storage, score 1.0', async () => {
    seedShotList([
      { shot: 1, visual_needed: 'hero shot', clip_file: `${GRAB_PREFIX}clips/hero.mp4`, duration_seconds: 5 },
    ]);
    setFakeBucketObject(privateBucket, `${GRAB_PREFIX}clips/hero.mp4`, { updatedAt: new Date().toISOString() });

    await runMatchStage(CTX);

    const resultText = privateBucket.get(`${MATCH_PREFIX}match_result.json`)?.content;
    const result = JSON.parse(resultText!);
    expect(result.shots[0]).toMatchObject({
      file: `${GRAB_PREFIX}clips/hero.mp4`,
      status: 'ok',
      matchScore: 1.0,
      matchType: 'script_specified',
      // assemble_rough_cut's trim target depends on this surviving into
      // match_result.json — it was previously being silently dropped.
      durationSeconds: 5,
    });
    expect(scoreCatalogAgainstLineMock).not.toHaveBeenCalled(); // Rule 1 short-circuits before Rule 2
  });

  it('Rule 1b: reuses a per-shot clip matching the deterministic clipName() even with no clip_file given', async () => {
    seedShotList([{ shot: 2, visual_needed: 'Dashboard Overview', duration_seconds: 5 }]);
    // clipName() for shot 2, visualNeeded "Dashboard Overview" ->
    // "shot02_dashboard-overview.mp4" (see scriptParser.test.ts).
    setFakeBucketObject(privateBucket, `${GRAB_PREFIX}clips/shot02_dashboard-overview.mp4`, { updatedAt: new Date().toISOString() });

    await runMatchStage(CTX);

    const result = JSON.parse(privateBucket.get(`${MATCH_PREFIX}match_result.json`)!.content!);
    expect(result.shots[0]).toMatchObject({
      file: `${GRAB_PREFIX}clips/shot02_dashboard-overview.mp4`,
      status: 'ok',
      matchScore: 1.0,
      matchType: 'per_shot_clip',
    });
  });

  it('Rule 2: picks the highest-scoring catalog clip at or above 0.5 confidence', async () => {
    seedShotList([{ shot: 1, visual_needed: 'export flow', script_line: 'then export your deck', duration_seconds: 5 }]);
    seedCatalog({
      'low.mp4': { caption: 'irrelevant', tags: [], has_ui: true, clip_type: 'ui' },
      'high.mp4': { caption: 'exporting a deck', tags: [], has_ui: true, clip_type: 'ui' },
    });
    scoreCatalogAgainstLineMock.mockResolvedValue({ 'low.mp4': 0.3, 'high.mp4': 0.9 });

    await runMatchStage(CTX);

    const result = JSON.parse(privateBucket.get(`${MATCH_PREFIX}match_result.json`)!.content!);
    expect(result.shots[0]).toMatchObject({ file: 'high.mp4', status: 'ok', matchScore: 0.9, matchType: 'vision_score' });
  });

  it('a clip already used by an earlier shot is never assigned to a later shot', async () => {
    seedShotList([
      { shot: 1, visual_needed: 'a', script_line: 'line a', duration_seconds: 5 },
      { shot: 2, visual_needed: 'b', script_line: 'line b', duration_seconds: 5 },
    ]);
    seedCatalog({ 'only.mp4': { caption: 'x', tags: [], has_ui: true, clip_type: 'ui' } });
    scoreCatalogAgainstLineMock.mockResolvedValue({ 'only.mp4': 0.9 });

    await runMatchStage(CTX);

    const result = JSON.parse(privateBucket.get(`${MATCH_PREFIX}match_result.json`)!.content!);
    expect(result.shots[0].file).toBe('only.mp4');
    expect(result.shots[1].status).toBe('missing'); // the only candidate was already used
    expect(result.shots[1].file).toBeNull();
  });

  it('marks a shot missing (with a reason) when no rule produces a confident match', async () => {
    seedShotList([{ shot: 1, visual_needed: 'nonexistent thing', script_line: 'show the nonexistent thing', duration_seconds: 5 }]);

    const result0 = await runMatchStage(CTX);
    const result = JSON.parse(privateBucket.get(`${MATCH_PREFIX}match_result.json`)!.content!);

    expect(result.shots[0].status).toBe('missing');
    expect(result.shots[0].error).toMatch(/insufficient website assets/);
    expect(result0.data?.matchedCount).toBe(0);
  });

  it("marks a trial-sourced shot 'needs_trial' without attempting any clip matching", async () => {
    seedShotList([{ shot: 1, visual_needed: 'proof', source: 'trial', duration_seconds: 5 }]);

    await runMatchStage(CTX);

    const result = JSON.parse(privateBucket.get(`${MATCH_PREFIX}match_result.json`)!.content!);
    expect(result.shots[0].status).toBe('needs_trial');
    expect(scoreCatalogAgainstLineMock).not.toHaveBeenCalled();
  });

  it('treats a missing clip_catalog.json as an empty catalog rather than erroring', async () => {
    seedShotList([{ shot: 1, visual_needed: 'x', script_line: 'x', duration_seconds: 5 }]);
    // No clip_catalog.json seeded at all.

    const result = await runMatchStage(CTX);

    expect(result.data?.clipsAvailable).toBe(0);
  });
});
