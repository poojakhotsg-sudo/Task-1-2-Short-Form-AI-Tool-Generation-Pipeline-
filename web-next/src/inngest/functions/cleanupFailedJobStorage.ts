import { inngest } from '@/lib/inngest';
import { getSupabaseServerClient } from '@/lib/supabase';
import { deleteAllUnderPrefix } from '@/lib/objectStorage';
import type { SweepContext } from './sweepContext';

// Tier 2 of storage-retention-policy.md: failed/interrupted/stopped jobs,
// 7 days past their last update. Deletes storage (media + manifests both
// — unlike tier 3, nothing about a failed job's output is worth keeping
// as "current") and the job's own DB rows (assets, job_stages, jobs).
//
// Schedule and retention window are defaults to confirm, not settled
// (storage-retention-policy.md's framing applies here too).
const FAILED_STATUSES = ['failed', 'interrupted', 'stopped'] as const;
const RETENTION_DAYS = 7;
// Bounded batch size per run (Section 9: "bounded concurrency") — a tool
// with a large backlog of old failed jobs gets cleaned up over several
// daily runs, not one unbounded sweep.
const BATCH_SIZE = 25;

// Exported separately from createFunction so tests can call it directly
// with a lightweight fake context, without needing Inngest's runtime.
export async function cleanupFailedJobStorageHandler({ step, logger }: SweepContext) {
    const cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const candidates = await step.run('find-candidate-jobs', async () => {
      const supabase = getSupabaseServerClient();
      const { data, error } = await supabase
        .from('jobs')
        .select('id, tool_slug')
        .in('status', FAILED_STATUSES)
        .lt('updated_at', cutoffIso)
        .limit(BATCH_SIZE);
      if (error) throw error;
      return data ?? [];
    });

    if (candidates.length === 0) {
      logger.info('cleanup-failed-job-storage: no candidates', { cutoffIso });
      return { cleaned: 0, candidateCount: 0 };
    }

    // One step per job, not one step for the whole batch: if this
    // function is retried partway through, Inngest's step memoization
    // means already-completed jobs' cleanup steps aren't redone — only
    // the job that failed (or hadn't started yet) runs again. Each job's
    // own cleanup is still internally idempotent (see cleanupOneFailedJob)
    // as a second line of defense, since step memoization is keyed on step
    // id + input, not a guarantee against every possible retry shape.
    for (const job of candidates) {
      await step.run(`cleanup-job-${job.id}`, () => cleanupOneFailedJob(job.id, job.tool_slug));
    }

    return { cleaned: candidates.length, candidateCount: candidates.length };
}

export const cleanupFailedJobStorage = inngest.createFunction(
  { id: 'cleanup-failed-job-storage', retries: 3, triggers: [{ cron: '0 3 * * *' }] },
  cleanupFailedJobStorageHandler
);

async function cleanupOneFailedJob(jobId: string, toolSlug: string | null): Promise<void> {
  const supabase = getSupabaseServerClient();

  // Job-scoped prefix only. This never touches public/tools/<slug>/
  // lead_magnet.* (not job-scoped at all — tier 6, never deleted) or
  // private/tools/<slug>/manual/** (tool-scoped, tier 7, never deleted);
  // both are excluded by construction since neither lives under
  // jobs/<jobId>/.
  const deletedKeys = toolSlug
    ? await deleteAllUnderPrefix(`private/tools/${toolSlug}/jobs/${jobId}/`)
    : [];

  // Delete storage before DB rows (storage-retention-policy.md's ordering
  // rule): if the storage delete above throws, we never reach here, and
  // this job stays eligible for the next run to retry from the top rather
  // than leaving an orphaned object the reconciliation sweep would have to
  // separately rediscover.
  const { error: assetsError } = await supabase.from('assets').delete().eq('job_id', jobId);
  if (assetsError) throw assetsError;

  const { error: stagesError } = await supabase.from('job_stages').delete().eq('job_id', jobId);
  if (stagesError) throw stagesError;

  // Audit rows are inserted while the jobs row still exists — the FK
  // requires a live target. Deleting that row next doesn't fail this: it
  // triggers ON DELETE SET NULL on these just-inserted rows (migration
  // 0004), unlinking them from the now-gone job without erroring. The
  // audit trail survives; only the link does not.
  const auditRows = [
    ...deletedKeys.map((key) => ({
      tier: 2,
      job_id: jobId,
      storage_key: key,
      deleted_db_row: false,
    })),
    { tier: 2, job_id: jobId, storage_key: null, deleted_db_row: true },
  ];
  const { error: auditError } = await supabase.from('storage_cleanup_runs').insert(auditRows);
  if (auditError) throw auditError;

  const { error: jobError } = await supabase.from('jobs').delete().eq('id', jobId);
  if (jobError) throw jobError;
}
