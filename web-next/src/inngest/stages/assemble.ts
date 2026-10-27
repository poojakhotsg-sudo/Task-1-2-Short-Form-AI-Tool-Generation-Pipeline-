import { callWorkerTask } from '@/lib/workerClient';
import type { StageExecutor } from './types';
import { stageStoragePrefix } from './types';

// PIPE-09: join matched shots into a 1080x1920 rough cut (ffmpeg H.264,
// CRF 20, 30fps, black placeholder cards for uncovered shots). Native
// media work — delegates to the worker's assemble_rough_cut task.
export const runAssembleStage: StageExecutor = async (ctx) => {
  const result = await callWorkerTask('assemble_rough_cut', {
    jobId: ctx.jobId,
    toolSlug: ctx.toolSlug,
    toolName: ctx.toolName, // for summary.md's "# <tool> rough cut" heading — was missing
    matchStoragePrefix: stageStoragePrefix(ctx, 'match'),
    storagePrefix: stageStoragePrefix(ctx, 'assemble'),
  });

  if (result.status === 'error') {
    throw new Error(result.message || 'assemble stage failed');
  }

  return { message: result.message, data: result.data };
};
