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

import { cleanupOrphanedStorageHandler } from '@/inngest/functions/cleanupOrphanedStorage';

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

// An orphan whose job row still exists (e.g. an assets row for it was
// deleted separately without the job being touched).
const ORPHAN_WITH_LIVE_JOB_KEY = 'private/tools/demo/jobs/liveJob/extract/images/stray.png';
// An orphan whose job row is already gone — the more realistic case
// (e.g. tier 2 deleted the job's assets/jobs rows but failed partway
// through deleting this one storage object).
const ORPHAN_WITH_DEAD_JOB_KEY = 'private/tools/demo/jobs/longGoneJob/grab/clips/stray.mp4';
// Referenced by a real assets row — must never be touched regardless of
// age.
const REFERENCED_KEY = 'private/tools/demo/jobs/liveJob/extract/manifest.json';
// Old enough by age, but inside the job's tmp/ subfolder — tier 1's
// territory, not tier 0's; must be left alone even though nothing
// references it either (tmp is deliberately untracked in assets).
const TMP_KEY = 'private/tools/demo/jobs/liveJob/tmp/scratch.mp4';
// Within the 48h grace window — too new to touch regardless of
// reference status, to avoid racing an in-flight upload.
const RECENT_UNREFERENCED_KEY = 'private/tools/demo/jobs/liveJob/extract/images/just-uploaded.png';

beforeEach(() => {
  db = createFakeDb();
  db.jobs.push({ id: 'liveJob', tool_slug: 'demo', status: 'done' });
  // longGoneJob deliberately has no row in db.jobs at all.
  db.assets.push({
    id: 'a1',
    job_id: 'liveJob',
    storage_key: REFERENCED_KEY,
    filename: 'manifest.json',
    content_type: 'application/json',
  });

  privateBucket = createFakeStorageBucket({
    [ORPHAN_WITH_LIVE_JOB_KEY]: { updatedAt: hoursAgo(72) },
    [ORPHAN_WITH_DEAD_JOB_KEY]: { updatedAt: hoursAgo(72) },
    [REFERENCED_KEY]: { updatedAt: hoursAgo(72) },
    [TMP_KEY]: { updatedAt: hoursAgo(72) },
    [RECENT_UNREFERENCED_KEY]: { updatedAt: hoursAgo(1) },
  });
});

describe('cleanupOrphanedStorageHandler (tier 0)', () => {
  it('deletes aged, unreferenced objects while leaving referenced, tmp/, and recent objects alone', async () => {
    const result = await cleanupOrphanedStorageHandler(createFakeSweepContext());

    expect(result).toEqual({ checked: 4, orphansDeleted: 2 });

    expect(privateBucket.has(ORPHAN_WITH_LIVE_JOB_KEY)).toBe(false);
    expect(privateBucket.has(ORPHAN_WITH_DEAD_JOB_KEY)).toBe(false);

    // Referenced by a real assets row — never touched.
    expect(privateBucket.has(REFERENCED_KEY)).toBe(true);
    // tmp/ — tier 1's job, excluded from the walk entirely.
    expect(privateBucket.has(TMP_KEY)).toBe(true);
    // Too recent — inside the 48h grace period.
    expect(privateBucket.has(RECENT_UNREFERENCED_KEY)).toBe(true);

    // Tier 0 never touches DB rows — not even for the orphans.
    expect(db.jobs).toHaveLength(1);
    expect(db.assets).toHaveLength(1);
  });

  it("sets job_id on the audit row only when that job still exists, to avoid violating storage_cleanup_runs' FK", async () => {
    await cleanupOrphanedStorageHandler(createFakeSweepContext());

    const liveJobRow = db.storage_cleanup_runs.find((r) => r.storage_key === ORPHAN_WITH_LIVE_JOB_KEY);
    const deadJobRow = db.storage_cleanup_runs.find((r) => r.storage_key === ORPHAN_WITH_DEAD_JOB_KEY);

    expect(liveJobRow).toMatchObject({ tier: 0, job_id: 'liveJob', deleted_db_row: false });
    // The job this path implies no longer exists — job_id must be null,
    // not the dangling id, since inserting a real FK reference to a
    // nonexistent jobs row would fail outright (unlike tier 2's ON
    // DELETE SET NULL case, where the row exists at insert time and is
    // only deleted afterward).
    expect(deadJobRow).toMatchObject({ tier: 0, job_id: null, deleted_db_row: false });
  });

  it('does nothing when every aged, unreferenced candidate turns out to not exist', async () => {
    privateBucket.clear();

    const result = await cleanupOrphanedStorageHandler(createFakeSweepContext());

    expect(result).toEqual({ checked: 0, orphansDeleted: 0 });
    expect(db.storage_cleanup_runs).toHaveLength(0);
  });

  it('is idempotent — running twice does not re-delete or double-audit', async () => {
    const first = await cleanupOrphanedStorageHandler(createFakeSweepContext());
    const second = await cleanupOrphanedStorageHandler(createFakeSweepContext());

    expect(first).toEqual({ checked: 4, orphansDeleted: 2 });
    expect(second).toEqual({ checked: 2, orphansDeleted: 0 });
    expect(db.storage_cleanup_runs).toHaveLength(2);
  });
});
