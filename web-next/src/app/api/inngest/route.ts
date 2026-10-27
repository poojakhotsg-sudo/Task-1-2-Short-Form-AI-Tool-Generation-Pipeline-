export const dynamic = 'force-dynamic';

import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest';
import { runReelPipeline } from '@/inngest/functions/runReelPipeline';
import { runExtractJob } from '@/inngest/functions/runExtractJob';
import { cleanupOrphanedStorage } from '@/inngest/functions/cleanupOrphanedStorage';
import { cleanupTmpStorage } from '@/inngest/functions/cleanupTmpStorage';
import { cleanupFailedJobStorage } from '@/inngest/functions/cleanupFailedJobStorage';
import { cleanupSupersededJobMedia } from '@/inngest/functions/cleanupSupersededJobMedia';

// Inngest's dev-server/cloud dispatch endpoint. run-reel-pipeline (Phase
// 3, requirement.md Section 12) orchestrates the grab->upload stage
// graph; all worker-delegating stages will fail until the Phase 4
// TypeScript worker actually exists and WORKER_BASE_URL points at it.
// run-extract-job is the separate, single-task job_type='extract' flow
// (EXTRACT-* numbering) — not a step in the reel pipeline's stage graph,
// see runExtractJob.ts's file-level comment. The four storage-retention
// sweeps (tiers 0-3) stand on their own.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    runReelPipeline,
    runExtractJob,
    cleanupOrphanedStorage,
    cleanupTmpStorage,
    cleanupFailedJobStorage,
    cleanupSupersededJobMedia,
  ],
});
