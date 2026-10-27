import { inngest } from '@/lib/inngest';
import { setJobStatus, upsertStageStatus } from '@/lib/jobState';
import { callWorkerTask } from '@/lib/workerClient';
import { getSupabaseServerClient } from '@/lib/supabase';
import type { SweepContext } from './sweepContext';

// EXTRACT-01..07's asset extraction (job_type 'extract'), wired to the
// worker's real /tasks/extract_media (see reel-pipeline/worker/src/
// services/extractMedia.ts and its docs/extract-media.md). Unlike
// run-reel-pipeline.ts, this is a single-task job — one worker call, one
// job_stages row ('extract', added to the stage_name enum by migration
// 0006 specifically because this isn't one of PIPE-01's 8 stages) — so
// there's no stage graph, no dependency-skipping, and no per-stage
// cooperative-cancellation loop to run: the only unit of work IS the
// worker call, which can't be interrupted mid-flight once started
// anyway. A stop request against an extract job is not wired up for
// that reason — flagged here rather than silently pretending `DELETE
// /api/jobs/:id` does something useful for this job_type.

interface JobCreatedEventData {
  jobId: string;
  toolSlug: string;
  toolName: string;
  url: string;
  headed?: boolean;
}

// The worker's inline manifest entry shape (extractMedia.ts's
// ManifestEntry, plus the storageKey/mp4StorageKey the route adds) —
// mirrored here by hand, same as every other cross-project contract in
// this app (workerClient.ts's own file-level comment explains why there
// isn't a shared package yet).
interface WorkerManifestEntry {
  category: 'videos_gifs' | 'images';
  type: string;
  filename: string;
  path: string;
  mp4: string | null;
  sourceUrl: string;
  originalFilename: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  sizeBytes: number;
  pageOrder: number;
  pageY: number | null;
  section: string;
  storageKey: string;
  mp4StorageKey: string | null;
}

// Writes one `assets` row per manifest entry. Two columns are left null,
// on purpose, not by oversight: `content_type` (the worker's manifest
// entry doesn't carry a MIME type, only a file extension already baked
// into `filename`/`path`) and `checksum_sha256` (computed internally by
// the worker's own dedup pass and discarded, not returned in the
// response). Populating either would mean either re-deriving a value
// this app doesn't actually have, or extending the worker's response
// shape again — left as a follow-up, not invented here.
async function writeAssetRows(jobId: string, toolSlug: string, manifest: WorkerManifestEntry[]): Promise<void> {
  if (manifest.length === 0) return;
  const supabase = getSupabaseServerClient();
  const rows = manifest.map((m) => ({
    tool_slug: toolSlug,
    job_id: jobId,
    kind: 'extract' as const,
    category: m.category,
    storage_key: m.storageKey,
    filename: m.filename,
    content_type: null,
    source_url: m.sourceUrl,
    width: m.width,
    height: m.height,
    duration_seconds: m.durationSeconds,
    size_bytes: m.sizeBytes,
    page_order: m.pageOrder,
    section_heading: m.section,
    checksum_sha256: null,
    mp4_storage_key: m.mp4StorageKey,
  }));
  const { error } = await supabase.from('assets').insert(rows);
  if (error) throw error;
}

// Exported separately from createFunction, same reasoning as
// runReelPipelineHandler: tests call this directly with a lightweight
// fake context, no Inngest runtime needed.
export async function runExtractJobHandler({
  event,
  step,
  logger,
}: SweepContext & { event: { data: JobCreatedEventData } }) {
  const { jobId, toolSlug, toolName, url, headed } = event.data;
  const storagePrefix = `private/tools/${toolSlug}/jobs/${jobId}/extract/`;

  await step.run('mark-job-running', () => setJobStatus(jobId, 'running', { started_at: new Date().toISOString() }));
  await step.run('mark-stage-running', () =>
    upsertStageStatus(jobId, 'extract', { status: 'running', started_at: new Date().toISOString() })
  );

  const outcome = await step.run('run-extract-media', async () => {
    try {
      const result = await callWorkerTask('extract_media', { jobId, toolSlug, toolName, url, storagePrefix, headed: headed ?? false });
      if (result.status === 'error') {
        return { ok: false as const, message: result.message || 'extract_media failed' };
      }
      return { ok: true as const, message: result.message, manifest: (result.data?.manifest as WorkerManifestEntry[] | undefined) ?? [] };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  });

  if (outcome.ok) {
    await step.run('write-asset-rows', () => writeAssetRows(jobId, toolSlug, outcome.manifest));
  }

  await step.run('mark-stage-finished', () =>
    upsertStageStatus(jobId, 'extract', {
      status: outcome.ok ? 'done' : 'failed',
      message: outcome.message ?? null,
      finished_at: new Date().toISOString(),
    })
  );

  await step.run('mark-job-finished', () =>
    setJobStatus(jobId, outcome.ok ? 'done' : 'failed', {
      finished_at: new Date().toISOString(),
      error: outcome.ok ? null : outcome.message,
    })
  );

  logger.info('run-extract-job: finished', { jobId, status: outcome.ok ? 'done' : 'failed' });
  return { status: outcome.ok ? 'done' : 'failed' };
}

export const runExtractJob = inngest.createFunction(
  { id: 'run-extract-job', retries: 2, triggers: [{ event: 'extract/job.created' }] },
  runExtractJobHandler
);
