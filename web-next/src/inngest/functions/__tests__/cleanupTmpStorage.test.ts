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

// Imported after the mock is declared (vi.mock calls are hoisted by
// vitest regardless of position, but keeping this below documents the
// dependency clearly).
import { cleanupTmpStorageHandler } from '@/inngest/functions/cleanupTmpStorage';

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  db = createFakeDb();
  privateBucket = createFakeStorageBucket({
    // Stale — older than the 24h window, and under a tmp/ path. Should
    // be deleted.
    'private/tools/demo/jobs/job1/tmp/foo.mp4': { updatedAt: hoursAgo(48) },
    // Fresh — under tmp/ but well within the window. Must survive.
    'private/tools/demo/jobs/job1/tmp/bar.mp4': { updatedAt: hoursAgo(1) },
    // Old, but NOT under a tmp/ path — tier 1 only ever walks
    // private/tools/<slug>/jobs/<id>/tmp/, so this must never be touched
    // regardless of age. Catches an over-broad implementation that
    // swept everything old, not just tmp/.
    'private/tools/demo/jobs/job1/extract/images/baz.png': { updatedAt: hoursAgo(240) },
  });
});

describe('cleanupTmpStorageHandler (tier 1)', () => {
  it('deletes only stale objects under tmp/, leaving fresh tmp and non-tmp objects alone', async () => {
    const result = await cleanupTmpStorageHandler(createFakeSweepContext());

    expect(result).toEqual({ deleted: 1 });
    expect(privateBucket.has('private/tools/demo/jobs/job1/tmp/foo.mp4')).toBe(false);
    expect(privateBucket.has('private/tools/demo/jobs/job1/tmp/bar.mp4')).toBe(true);
    expect(privateBucket.has('private/tools/demo/jobs/job1/extract/images/baz.png')).toBe(true);
  });

  it('is idempotent — running twice in a row is a no-op the second time', async () => {
    await cleanupTmpStorageHandler(createFakeSweepContext());
    const second = await cleanupTmpStorageHandler(createFakeSweepContext());

    expect(second).toEqual({ deleted: 0 });
  });
});
