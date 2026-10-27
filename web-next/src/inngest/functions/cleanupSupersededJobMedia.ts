import { inngest } from '@/lib/inngest';
import { getSupabaseServerClient } from '@/lib/supabase';
import { deleteKeys } from '@/lib/objectStorage';
import type { SweepContext } from './sweepContext';

// Tier 3 of storage-retention-policy.md: a tool's successful jobs that
// have since been superseded by a newer successful job, 30 days past
// `finished_at`. Deletes media bytes ONLY — manifests/reports/logs (tier
// 4) and all DB rows (jobs/job_stages/assets) are kept indefinitely as
// history. This is the one tier that leaves a job's `assets` rows
// pointing at nothing: migration 0005's `purged_at` column is what marks
// that distinction, so a UI built against `assets` can tell "still
// downloadable" apart from "historical record only" instead of silently
// offering a dead link.
//
// Window and batch size are defaults to confirm, not settled.
const RETENTION_DAYS = 30;
const JOB_BATCH_SIZE = 25;

// Fallback for assets.content_type being null — matches the formats
// EXTRACT-01/05 actually produce, not an invented list.
const MEDIA_EXTENSIONS = [
  '.mp4', '.webm', '.mov', '.m4v', '.ogv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg',
];

function isMediaAsset(asset: { content_type: string | null; filename: string }): boolean {
  if (asset.content_type) {
    return asset.content_type.startsWith('video/') || asset.content_type.startsWith('image/');
  }
  const lower = asset.filename.toLowerCase();
  return MEDIA_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Exported separately from createFunction so tests can call it directly
// with a lightweight fake context, without needing Inngest's runtime.
export async function cleanupSupersededJobMediaHandler({ step, logger }: SweepContext) {
    const cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const candidates = await step.run('find-superseded-jobs', async () => {
      const supabase = getSupabaseServerClient();
      // Fetch every successful job, newest-first within each tool, then
      // group in JS rather than via a window-function query — keeps this
      // expressible with the supabase-js query builder instead of a
      // Postgres RPC, matching how tier 2 was written. Scaling note: this
      // is a full scan of `done` jobs every run; fine today, but if the
      // job table grows very large, maintaining an `is_current` flag on
      // `jobs` (set when a newer job for the same tool completes) would
      // turn this into an indexed lookup instead. Not built now because
      // nothing today indicates it's needed.
      const { data, error } = await supabase
        .from('jobs')
        .select('id, tool_slug, finished_at')
        .eq('status', 'done')
        .not('tool_slug', 'is', null)
        .order('tool_slug', { ascending: true })
        .order('finished_at', { ascending: false });
      if (error) throw error;

      const rows = data ?? [];
      const supersededPerTool: typeof rows = [];
      let currentToolSlug: string | null = null;
      for (const row of rows) {
        if (row.tool_slug !== currentToolSlug) {
          // First row seen for this tool_slug is the newest (current) one
          // — skip it, keep every row after.
          currentToolSlug = row.tool_slug;
          continue;
        }
        supersededPerTool.push(row);
      }

      return supersededPerTool
        .filter((row) => row.finished_at && row.finished_at < cutoffIso)
        .slice(0, JOB_BATCH_SIZE);
    });

    if (candidates.length === 0) {
      logger.info('cleanup-superseded-job-media: no candidates', { cutoffIso });
      return { jobsProcessed: 0, mediaDeleted: 0 };
    }

    let mediaDeleted = 0;
    for (const job of candidates) {
      const deletedCount = await step.run(`purge-media-job-${job.id}`, () =>
        purgeMediaForJob(job.id)
      );
      mediaDeleted += deletedCount;
    }

    return { jobsProcessed: candidates.length, mediaDeleted };
}

export const cleanupSupersededJobMedia = inngest.createFunction(
  { id: 'cleanup-superseded-job-media', retries: 3, triggers: [{ cron: '30 3 * * *' }] },
  cleanupSupersededJobMediaHandler
);

async function purgeMediaForJob(jobId: string): Promise<number> {
  const supabase = getSupabaseServerClient();

  const { data: assets, error: assetsError } = await supabase
    .from('assets')
    .select('id, storage_key, filename, content_type')
    .eq('job_id', jobId)
    .is('purged_at', null);
  if (assetsError) throw assetsError;

  const mediaAssets = (assets ?? []).filter(isMediaAsset);
  if (mediaAssets.length === 0) return 0;

  const keys = mediaAssets.map((a) => a.storage_key);
  // Precise key deletion, not a prefix delete (object-storage layout puts
  // media and manifests side by side under the same job/stage folder —
  // deleting the whole folder would violate tier 4's "kept indefinitely").
  await deleteKeys(keys);

  const assetIds = mediaAssets.map((a) => a.id);
  const { error: updateError } = await supabase
    .from('assets')
    .update({ purged_at: new Date().toISOString() })
    .in('id', assetIds);
  if (updateError) throw updateError;

  const auditRows = mediaAssets.map((a) => ({
    tier: 3,
    job_id: jobId,
    storage_key: a.storage_key,
    deleted_db_row: false, // the assets row is kept — only its bytes are gone
  }));
  const { error: auditError } = await supabase.from('storage_cleanup_runs').insert(auditRows);
  if (auditError) throw auditError;

  return mediaAssets.length;
}
