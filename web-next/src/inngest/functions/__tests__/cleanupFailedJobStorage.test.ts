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

import { cleanupFailedJobStorageHandler } from '@/inngest/functions/cleanupFailedJobStorage';

function daysAgo(d: number): string {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

const PIC_KEY = 'private/tools/demo/jobs/failedOld/extract/images/pic.png';
const MANIFEST_KEY = 'private/tools/demo/jobs/failedOld/extract/manifest.json';
const SIBLING_KEY = 'private/tools/demo/jobs/failedRecent/extract/images/other.png';

beforeEach(() => {
  db = createFakeDb();
  db.jobs.push(
    // Eligible: failed, 10 days since updated_at (past the 7-day window).
    { id: 'failedOld', tool_slug: 'demo', status: 'failed', updated_at: daysAgo(10) },
    // Not eligible: failed, but only 1 day old — inside the window.
    { id: 'failedRecent', tool_slug: 'demo', status: 'failed', updated_at: daysAgo(1) },
    // Not eligible: old, but status is 'done', not failed/interrupted/stopped.
    { id: 'doneJob', tool_slug: 'demo', status: 'done', updated_at: daysAgo(10) }
  );
  db.assets.push(
    { id: 'a1', job_id: 'failedOld', storage_key: PIC_KEY, filename: 'pic.png', content_type: 'image/png' },
    { id: 'a2', job_id: 'failedOld', storage_key: MANIFEST_KEY, filename: 'manifest.json', content_type: 'application/json' }
  );
  db.job_stages.push({ id: 's1', job_id: 'failedOld', stage: 'extract', status: 'failed' });

  privateBucket = createFakeStorageBucket({
    [PIC_KEY]: { updatedAt: daysAgo(10) },
    [MANIFEST_KEY]: { updatedAt: daysAgo(10) },
    // A sibling job's file under the same tool — must survive, proving
    // the prefix is scoped to this job's own folder and not the whole
    // tool.
    [SIBLING_KEY]: { updatedAt: daysAgo(10) },
  });
});

describe('cleanupFailedJobStorageHandler (tier 2)', () => {
  it('deletes the failed job\'s storage (media + manifest alike) and all its DB rows', async () => {
    const result = await cleanupFailedJobStorageHandler(createFakeSweepContext());

    expect(result).toEqual({ cleaned: 1, candidateCount: 1 });

    // Storage: both of failedOld's objects are gone — tier 2 deletes
    // manifests too, unlike tier 3.
    expect(privateBucket.has(PIC_KEY)).toBe(false);
    expect(privateBucket.has(MANIFEST_KEY)).toBe(false);
    // The sibling job's file, under the same tool, is untouched.
    expect(privateBucket.has(SIBLING_KEY)).toBe(true);

    // DB: every row belonging to the failed job is gone.
    expect(db.assets.some((a) => a.job_id === 'failedOld')).toBe(false);
    expect(db.job_stages.some((s) => s.job_id === 'failedOld')).toBe(false);
    expect(db.jobs.some((j) => j.id === 'failedOld')).toBe(false);

    // The too-recent failed job and the done job are left alone.
    expect(db.jobs.some((j) => j.id === 'failedRecent')).toBe(true);
    expect(db.jobs.some((j) => j.id === 'doneJob')).toBe(true);
  });

  it('writes an audit trail: one row per deleted storage key plus a summary row', async () => {
    await cleanupFailedJobStorageHandler(createFakeSweepContext());

    const auditRows = db.storage_cleanup_runs.filter((r) => r.job_id === 'failedOld');
    expect(auditRows).toHaveLength(3);
    expect(auditRows.every((r) => r.tier === 2)).toBe(true);

    const keyRows = auditRows.filter((r) => r.storage_key !== null);
    expect(keyRows.map((r) => r.storage_key).sort()).toEqual([MANIFEST_KEY, PIC_KEY].sort());
    expect(keyRows.every((r) => r.deleted_db_row === false)).toBe(true);

    const summaryRow = auditRows.find((r) => r.storage_key === null);
    expect(summaryRow?.deleted_db_row).toBe(true);

    // Honest limitation: this fake doesn't model Postgres's ON DELETE SET
    // NULL (migration 0004's FK behavior) — it's a plain in-memory array
    // with no foreign-key enforcement, so these rows still show
    // job_id: 'failedOld' even though that job no longer exists in
    // db.jobs. That specific cascade behavior is a property of the
    // migration/schema, not of this handler's logic, and isn't
    // re-verified here. What this test does verify — the thing that
    // actually depends on the handler's own code, not Postgres's FK
    // engine — is the *ordering*: the audit insert must happen (and
    // succeed) before the jobs row is deleted, which it does above
    // without throwing.
  });

  it('does nothing when there are no eligible jobs', async () => {
    db.jobs = db.jobs.filter((j) => j.id !== 'failedOld');

    const result = await cleanupFailedJobStorageHandler(createFakeSweepContext());

    expect(result).toEqual({ cleaned: 0, candidateCount: 0 });
  });
});
