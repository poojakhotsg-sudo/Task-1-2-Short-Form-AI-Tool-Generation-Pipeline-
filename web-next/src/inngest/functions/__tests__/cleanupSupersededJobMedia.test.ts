import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createFakeDb,
  createFakeStorageBucket,
  createFakeSupabaseClient,
  type FakeDb,
  type FakeBucket,
} from '@/test/fakeSupabase';
import { createFakeSweepContext } from '@/test/fakeStepContext';

let db: FakeDb;
let privateBucket: FakeBucket;

vi.mock('@/lib/supabase', () => ({
  getSupabaseServerClient: () => createFakeSupabaseClient(db, { 'reel-private': privateBucket }),
}));

import { cleanupSupersededJobMediaHandler } from '@/inngest/functions/cleanupSupersededJobMedia';

function daysAgo(d: number): string {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

const CLIP_KEY = 'private/tools/demo/jobs/jobA/grab/clips/clip01.mp4';
const HERO_KEY = 'private/tools/demo/jobs/jobA/grab/hero.png'; // content_type null — exercises the filename-extension fallback
const MANIFEST_KEY = 'private/tools/demo/jobs/jobA/extract/manifest.json';
const ALREADY_PURGED_KEY = 'private/tools/demo/jobs/jobA/grab/already-purged.mp4'; // deliberately not seeded in storage — simulates a prior real purge
const OTHER_TOOL_CLIP_KEY = 'private/tools/other/jobs/jobC/grab/clips/clip01.mp4';

beforeEach(() => {
  db = createFakeDb();

  db.jobs.push(
    // 'demo' tool: jobA is superseded by jobB and old enough (60 days).
    { id: 'jobA', tool_slug: 'demo', status: 'done', finished_at: daysAgo(60) },
    // 'demo' tool: jobB is the newest done job — this is "current," never touched.
    { id: 'jobB', tool_slug: 'demo', status: 'done', finished_at: daysAgo(5) },
    // 'other' tool: jobC is old (60 days) but it's the ONLY done job for
    // 'other', so it's current despite its age — must not be processed.
    // This is the key sanity check for the per-tool grouping logic.
    { id: 'jobC', tool_slug: 'other', status: 'done', finished_at: daysAgo(60) }
  );

  db.assets.push(
    { id: 'v1', job_id: 'jobA', storage_key: CLIP_KEY, filename: 'clip01.mp4', content_type: 'video/mp4', purged_at: null },
    { id: 'v2', job_id: 'jobA', storage_key: HERO_KEY, filename: 'hero.png', content_type: null, purged_at: null },
    { id: 'm1', job_id: 'jobA', storage_key: MANIFEST_KEY, filename: 'manifest.json', content_type: 'application/json', purged_at: null },
    // Already purged in an earlier run — must be excluded by the
    // purged_at IS NULL filter and left completely alone.
    { id: 'p1', job_id: 'jobA', storage_key: ALREADY_PURGED_KEY, filename: 'already-purged.mp4', content_type: 'video/mp4', purged_at: '2020-01-01T00:00:00.000Z' },
    { id: 'c1', job_id: 'jobC', storage_key: OTHER_TOOL_CLIP_KEY, filename: 'clip01.mp4', content_type: 'video/mp4', purged_at: null }
  );

  privateBucket = createFakeStorageBucket({
    [CLIP_KEY]: { updatedAt: daysAgo(60) },
    [HERO_KEY]: { updatedAt: daysAgo(60) },
    [MANIFEST_KEY]: { updatedAt: daysAgo(60) },
    [OTHER_TOOL_CLIP_KEY]: { updatedAt: daysAgo(60) },
    // ALREADY_PURGED_KEY intentionally not seeded — see comment above.
  });
});

describe('cleanupSupersededJobMediaHandler (tier 3)', () => {
  it("purges a superseded job's media (including the no-content_type filename fallback) but keeps manifests and DB rows", async () => {
    const result = await cleanupSupersededJobMediaHandler(createFakeSweepContext());

    expect(result).toEqual({ jobsProcessed: 1, mediaDeleted: 2 });

    // Media is gone from storage.
    expect(privateBucket.has(CLIP_KEY)).toBe(false);
    expect(privateBucket.has(HERO_KEY)).toBe(false);
    // The manifest — tier 4 — survives.
    expect(privateBucket.has(MANIFEST_KEY)).toBe(true);

    // The assets rows are KEPT (tier 3 never deletes rows), but the two
    // media rows are now marked purged; the manifest row is not.
    const v1 = db.assets.find((a) => a.id === 'v1');
    const v2 = db.assets.find((a) => a.id === 'v2');
    const m1 = db.assets.find((a) => a.id === 'm1');
    expect(v1?.purged_at).not.toBeNull();
    expect(v2?.purged_at).not.toBeNull();
    expect(m1?.purged_at).toBeNull();

    // The already-purged row is untouched — not re-processed, not
    // re-marked, not in the delete/audit path.
    const p1 = db.assets.find((a) => a.id === 'p1');
    expect(p1?.purged_at).toBe('2020-01-01T00:00:00.000Z');

    // No job/job_stages rows are ever touched by tier 3.
    expect(db.jobs).toHaveLength(3);
    expect(db.jobs.some((j) => j.id === 'jobA')).toBe(true);
  });

  it("never touches the current (newest) job for a tool, even one that's old", async () => {
    await cleanupSupersededJobMediaHandler(createFakeSweepContext());

    // jobC is the sole 'done' job for 'other' — current despite being 60
    // days old. Its asset must stay unpurged and its storage object must
    // survive.
    const c1 = db.assets.find((a) => a.id === 'c1');
    expect(c1?.purged_at).toBeNull();
    expect(privateBucket.has(OTHER_TOOL_CLIP_KEY)).toBe(true);
  });

  it('writes exactly one audit row per purged media key, none for the manifest or the already-purged asset', async () => {
    await cleanupSupersededJobMediaHandler(createFakeSweepContext());

    const auditRows = db.storage_cleanup_runs;
    expect(auditRows).toHaveLength(2);
    expect(auditRows.every((r) => r.tier === 3 && r.job_id === 'jobA' && r.deleted_db_row === false)).toBe(
      true
    );
    expect(auditRows.map((r) => r.storage_key).sort()).toEqual([CLIP_KEY, HERO_KEY].sort());
  });

  it('is idempotent — running twice does not re-purge or double-count', async () => {
    const first = await cleanupSupersededJobMediaHandler(createFakeSweepContext());
    const second = await cleanupSupersededJobMediaHandler(createFakeSweepContext());

    expect(first).toEqual({ jobsProcessed: 1, mediaDeleted: 2 });
    // Note: jobA is still selected as a "candidate" on the second run —
    // nothing marks a superseded job as fully processed once its media
    // is gone, so the find-candidates query keeps re-selecting it every
    // run forever. That's a real (minor) inefficiency worth knowing
    // about, not a bug: mediaDeleted stays 0 and nothing is double-
    // written, which is what idempotency actually requires here.
    expect(second).toEqual({ jobsProcessed: 1, mediaDeleted: 0 });
    expect(db.storage_cleanup_runs).toHaveLength(2);
  });
});
