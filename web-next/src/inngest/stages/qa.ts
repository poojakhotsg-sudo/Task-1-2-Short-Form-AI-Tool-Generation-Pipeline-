import { callWorkerTask } from '@/lib/workerClient';
import type { StageExecutor } from './types';
import { stageStoragePrefix } from './types';

// PIPE-06: automatic clip quality checks (duration, resolution, sharpness
// via Laplacian variance, blank/motion checks) — all native ffmpeg/
// ffprobe work, so this delegates to the worker's run_qa task.
export const runQaStage: StageExecutor = async (ctx) => {
  const result = await callWorkerTask('run_qa', {
    jobId: ctx.jobId,
    toolSlug: ctx.toolSlug,
    grabStoragePrefix: stageStoragePrefix(ctx, 'grab'),
    storagePrefix: stageStoragePrefix(ctx, 'qa'),
  });

  if (result.status === 'error') {
    throw new Error(result.message || 'qa stage failed');
  }

  return { message: result.message, data: result.data };
};
