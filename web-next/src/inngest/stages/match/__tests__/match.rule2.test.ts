import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createFakeStorageBucket,
  createFakeSupabaseClient,
  createFakeDb,
  setFakeBucketObject,
  type FakeBucket,
} from '@/test/fakeSupabase';

let privateBucket: FakeBucket;

vi.mock('@/lib/supabase', () => ({
  getSupabaseServerClient: () => createFakeSupabaseClient(createFakeDb(), { 'reel-private': privateBucket }),
}));

const { scoreCatalogAgainstLineMock } = vi.hoisted(() => ({ scoreCatalogAgainstLineMock: vi.fn() }));
vi.mock('@/inngest/stages/match/clipScoring', () => ({ scoreCatalogAgainstLine: scoreCatalogAgainstLineMock }));

import { runMatchStage } from '@/inngest/stages/match';

const CTX = { jobId: 'job1', toolSlug: 'demo', toolName: 'Demo', url: 'https://example.com' };
const SCRIPT_PREFIX = 'private/tools/demo/jobs/job1/script/';
const DESCRIBE_PREFIX = 'private/tools/demo/jobs/job1/describe/';
const MATCH_PREFIX = 'private/tools/demo/jobs/job1/match/';

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

async function runAndGetResult() {
  const stageResult = await runMatchStage(CTX);
  const stored = JSON.parse(privateBucket.get(`${MATCH_PREFIX}match_result.json`)!.content!);
  return { stageResult, stored };
}

beforeEach(() => {
  process.env.OBJECT_STORAGE_PRIVATE_BUCKET = 'reel-private';
  privateBucket = createFakeStorageBucket();
  scoreCatalogAgainstLineMock.mockReset();
  scoreCatalogAgainstLineMock.mockResolvedValue({});
});

describe('runMatchStage — Rule 2 (vision/LLM scoring)', () => {
  it('accepts a score exactly at the 0.5 confidence threshold (inclusive boundary)', async () => {
    seedShotList([{ shot: 1, visual_needed: 'x', script_line: 'line', duration_seconds: 5 }]);
    seedCatalog({ 'clip.mp4': { caption: 'x', tags: [], has_ui: true, clip_type: 'ui' } });
    scoreCatalogAgainstLineMock.mockResolvedValue({ 'clip.mp4': 0.5 });

    const { stored } = await runAndGetResult();

    expect(stored.shots[0]).toMatchObject({ file: 'clip.mp4', status: 'ok', matchScore: 0.5 });
  });

  it('rejects a score just below the 0.5 threshold, marking the shot missing', async () => {
    seedShotList([{ shot: 1, visual_needed: 'x', script_line: 'line', duration_seconds: 5 }]);
    seedCatalog({ 'clip.mp4': { caption: 'x', tags: [], has_ui: true, clip_type: 'ui' } });
    scoreCatalogAgainstLineMock.mockResolvedValue({ 'clip.mp4': 0.49 });

    const { stored } = await runAndGetResult();

    expect(stored.shots[0]).toMatchObject({ file: null, status: 'missing', matchScore: 0 });
  });

  it('rounds the stored match score to 2 decimal places, matching matcher.py\'s round(sc, 2)', async () => {
    seedShotList([{ shot: 1, visual_needed: 'x', script_line: 'line', duration_seconds: 5 }]);
    seedCatalog({ 'clip.mp4': { caption: 'x', tags: [], has_ui: true, clip_type: 'ui' } });
    scoreCatalogAgainstLineMock.mockResolvedValue({ 'clip.mp4': 0.8763 });

    const { stored } = await runAndGetResult();

    expect(stored.shots[0].matchScore).toBe(0.88);
  });

  it('picks the highest-scoring clip among several candidates, not just the first in the response', async () => {
    seedShotList([{ shot: 1, visual_needed: 'x', script_line: 'line', duration_seconds: 5 }]);
    seedCatalog({
      'a.mp4': { caption: 'a', tags: [], has_ui: true, clip_type: 'ui' },
      'b.mp4': { caption: 'b', tags: [], has_ui: true, clip_type: 'ui' },
      'c.mp4': { caption: 'c', tags: [], has_ui: true, clip_type: 'ui' },
    });
    scoreCatalogAgainstLineMock.mockResolvedValue({ 'a.mp4': 0.6, 'b.mp4': 0.95, 'c.mp4': 0.7 });

    const { stored } = await runAndGetResult();

    expect(stored.shots[0].file).toBe('b.mp4');
  });

  it('ignores a scored file that is not actually in the clip catalog (a hallucinated/mismatched filename)', async () => {
    seedShotList([{ shot: 1, visual_needed: 'x', script_line: 'line', duration_seconds: 5 }]);
    seedCatalog({ 'real.mp4': { caption: 'x', tags: [], has_ui: true, clip_type: 'ui' } });
    // The model returns a high score for a file that was never in the
    // catalog passed to it — must not be trusted blindly.
    scoreCatalogAgainstLineMock.mockResolvedValue({ 'made-up.mp4': 0.99, 'real.mp4': 0.6 });

    const { stored } = await runAndGetResult();

    expect(stored.shots[0].file).toBe('real.mp4');
  });

  it('excludes a clip already assigned to an earlier shot, even if it scores highest for this shot too', async () => {
    seedShotList([
      { shot: 1, visual_needed: 'a', script_line: 'line a', duration_seconds: 5 },
      { shot: 2, visual_needed: 'b', script_line: 'line b', duration_seconds: 5 },
    ]);
    seedCatalog({
      'best.mp4': { caption: 'best', tags: [], has_ui: true, clip_type: 'ui' },
      'ok.mp4': { caption: 'ok', tags: [], has_ui: true, clip_type: 'ui' },
    });
    // Same scores returned for both shots — "best.mp4" wins shot 1 and
    // must not be reused for shot 2, even though it would otherwise win there too.
    scoreCatalogAgainstLineMock.mockResolvedValue({ 'best.mp4': 0.9, 'ok.mp4': 0.6 });

    const { stored } = await runAndGetResult();

    expect(stored.shots[0].file).toBe('best.mp4');
    expect(stored.shots[1].file).toBe('ok.mp4');
  });

  it('calls scoreCatalogAgainstLine with the shot\'s own script line and the full catalog as {file, caption, tags, has_ui, clip_type} entries', async () => {
    seedShotList([{ shot: 1, visual_needed: 'export', script_line: 'then export your deck', duration_seconds: 5 }]);
    seedCatalog({ 'clip.mp4': { caption: 'exporting', tags: ['export', 'deck'], has_ui: true, clip_type: 'ui' } });

    await runAndGetResult();

    expect(scoreCatalogAgainstLineMock).toHaveBeenCalledWith('then export your deck', [
      { file: 'clip.mp4', caption: 'exporting', tags: ['export', 'deck'], has_ui: true, clip_type: 'ui' },
    ]);
  });

  it('still calls scoreCatalogAgainstLine (with an empty array) when the catalog is empty, rather than skipping Rule 2 entirely', async () => {
    seedShotList([{ shot: 1, visual_needed: 'x', script_line: 'line', duration_seconds: 5 }]);
    // No catalog seeded at all.

    const { stored } = await runAndGetResult();

    expect(scoreCatalogAgainstLineMock).toHaveBeenCalledWith('line', []);
    expect(stored.shots[0].status).toBe('missing');
  });

  it('only reaches Rule 2 after Rule 1 and Rule 1b both fail to resolve a clip', async () => {
    seedShotList([
      { shot: 1, visual_needed: 'x', script_line: 'line', clip_file: 'private/tools/demo/jobs/job1/grab/clips/named.mp4', duration_seconds: 5 },
    ]);
    seedCatalog({ 'scored.mp4': { caption: 'x', tags: [], has_ui: true, clip_type: 'ui' } });
    setFakeBucketObject(privateBucket, 'private/tools/demo/jobs/job1/grab/clips/named.mp4', { updatedAt: new Date().toISOString() });
    scoreCatalogAgainstLineMock.mockResolvedValue({ 'scored.mp4': 0.99 });

    const { stored } = await runAndGetResult();

    // Rule 1's script-specified clip exists in storage, so it wins —
    // Rule 2 is never consulted for this shot at all.
    expect(stored.shots[0]).toMatchObject({ file: 'private/tools/demo/jobs/job1/grab/clips/named.mp4', matchType: 'script_specified' });
    expect(scoreCatalogAgainstLineMock).not.toHaveBeenCalled();
  });

  it('propagates a scoring-call rejection as a failure of the whole stage (no defensive catch in match.ts — it relies on clipScoring\'s own "never throws" contract)', async () => {
    seedShotList([{ shot: 1, visual_needed: 'x', script_line: 'line', duration_seconds: 5 }]);
    seedCatalog({ 'clip.mp4': { caption: 'x', tags: [], has_ui: true, clip_type: 'ui' } });
    scoreCatalogAgainstLineMock.mockRejectedValue(new Error('model call exploded'));

    // This documents real, current behavior — not a desired contract.
    // match.ts has no try/catch around scoreCatalogAgainstLine, so a
    // mock (or a future bug) that violates clipScoring.ts's "always
    // resolves, never throws" contract takes down the entire match
    // stage, not just the one shot being scored.
    await expect(runMatchStage(CTX)).rejects.toThrow('model call exploded');
  });
});
