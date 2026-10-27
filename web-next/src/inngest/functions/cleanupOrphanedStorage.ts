import { inngest } from '@/lib/inngest';
import { getSupabaseServerClient } from '@/lib/supabase';
import { deleteKeys, listJobObjectsExcludingTmp } from '@/lib/objectStorage';
import type { SweepContext } from './sweepContext';

// Tier 0 of storage-retention-policy.md: objects under a job's own folder
// with no matching `assets.storage_key` row — catches storage/DB drift
// from a worker crashing between writing an object and inserting its
// row, independent of age-based tiers 1-3 (which only ever act on
// DB-known or tmp-pattern-known candidates, never on "storage has this,
// the DB doesn't know about it"). Storage only — never deletes a DB row,
// since by definition nothing in the DB points at what's being deleted
// here.
//
// 48h grace period and schedule are defaults to confirm, not settled.
const GRACE_HOURS = 48;
const STORAGE_BATCH_SIZE = 500;
const DB_PAGE_SIZE = 1000;

// Matches object-storage-layout.md's convention exactly:
// private/tools/<slug>/jobs/<jobId>/<rest...>
const JOB_KEY_PATTERN = /^private\/tools\/([^/]+)\/jobs\/([^/]+)\//;

// Exported separately from createFunction so tests can call it directly
// with a lightweight fake context, without needing Inngest's runtime.
export async function cleanupOrphanedStorageHandler({ step, logger }: SweepContext) {
  const cutoffMs = Date.now() - GRACE_HOURS * 60 * 60 * 1000;

  const candidates = await step.run('list-job-objects', () =>
    listJobObjectsExcludingTmp(STORAGE_BATCH_SIZE)
  );

  const orphanKeys = candidates
    .filter((obj) => !obj.updatedAt || new Date(obj.updatedAt).getTime() < cutoffMs)
    .map((obj) => obj.key);

  if (orphanKeys.length === 0) {
    logger.info('cleanup-orphaned-storage: no aged candidates', { cutoffMs });
    return { checked: candidates.length, orphansDeleted: 0 };
  }

  // The DB side of this comparison must be comprehensive, not bounded
  // like the storage-listing side above: under-fetching referenced keys
  // here would mean treating a real, live asset as an orphan and
  // deleting it. Bounding the storage listing just means less work gets
  // done this run (safe — the rest is picked up next run); bounding this
  // query would be a correctness bug, not a performance tradeoff. Hence
  // the full pagination loop instead of a single capped `.limit()` call.
  const referencedKeys = await step.run('fetch-referenced-storage-keys', fetchAllReferencedStorageKeys);

  const trueOrphans = orphanKeys.filter((key) => !referencedKeys.has(key));

  if (trueOrphans.length === 0) {
    logger.info('cleanup-orphaned-storage: all aged candidates are referenced', {
      checked: candidates.length,
    });
    return { checked: candidates.length, orphansDeleted: 0 };
  }

  await step.run('delete-orphan-keys', () => deleteOrphans(trueOrphans));

  logger.info('cleanup-orphaned-storage: deleted orphaned objects', {
    checked: candidates.length,
    orphansDeleted: trueOrphans.length,
  });
  return { checked: candidates.length, orphansDeleted: trueOrphans.length };
}

export const cleanupOrphanedStorage = inngest.createFunction(
  { id: 'cleanup-orphaned-storage', retries: 3, triggers: [{ cron: '0 4 * * *' }] },
  cleanupOrphanedStorageHandler
);

async function fetchAllReferencedStorageKeys(): Promise<Set<string>> {
  const supabase = getSupabaseServerClient();
  const keys = new Set<string>();
  let from = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('assets')
      .select('storage_key')
      .range(from, from + DB_PAGE_SIZE - 1);
    if (error) throw error;

    for (const row of data ?? []) {
      const key = (row as { storage_key: string | null }).storage_key;
      if (key) keys.add(key);
    }

    if (!data || data.length < DB_PAGE_SIZE) break;
    from += DB_PAGE_SIZE;
  }

  return keys;
}

async function deleteOrphans(keys: string[]): Promise<void> {
  await deleteKeys(keys);

  // job_id is only set on the audit row when the job it was extracted
  // from the path still actually exists — an orphaned object's job row
  // was very possibly already deleted (e.g. by tier 2, which may have
  // failed partway through deleting this exact object, which is one of
  // the scenarios this sweep exists to clean up after). Inserting an
  // audit row referencing a job_id that no longer exists would violate
  // storage_cleanup_runs' FK (migration 0004) and fail the whole sweep —
  // unlike tier 2, where the job row is still guaranteed to exist at
  // insert time, this function cannot assume that.
  const supabase = getSupabaseServerClient();
  const extractedJobIds = new Set<string>();
  for (const key of keys) {
    const match = key.match(JOB_KEY_PATTERN);
    if (match) extractedJobIds.add(match[2]);
  }

  let existingJobIds = new Set<string>();
  if (extractedJobIds.size > 0) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id')
      .in('id', Array.from(extractedJobIds));
    if (error) throw error;
    existingJobIds = new Set((data ?? []).map((row) => (row as { id: string }).id));
  }

  const auditRows = keys.map((key) => {
    const match = key.match(JOB_KEY_PATTERN);
    const jobId = match && existingJobIds.has(match[2]) ? match[2] : null;
    return { tier: 0, job_id: jobId, storage_key: key, deleted_db_row: false };
  });

  const { error: auditError } = await supabase.from('storage_cleanup_runs').insert(auditRows);
  if (auditError) throw auditError;
}
