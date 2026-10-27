import { callWorkerTask } from '@/lib/workerClient';
import type { StageExecutor } from './types';
import { stageStoragePrefix } from './types';

// PIPE-03: catalog every clip grab produced with a vision model (frame
// extraction + Claude/Groq vision call). The frame extraction is the
// worker's job (native ffmpeg); this executor delegates to describe_clips
// and trusts the worker to make the actual vision-model call itself,
// since that's where the extracted frames already are — round-tripping
// frame images through this Next.js app just to call the model would
// mean handling media bytes here, which Section 2.1 explicitly says not
// to do.
export const runDescribeStage: StageExecutor = async (ctx) => {
  const result = await callWorkerTask('describe_clips', {
    jobId: ctx.jobId,
    toolSlug: ctx.toolSlug,
    grabStoragePrefix: stageStoragePrefix(ctx, 'grab'),
    storagePrefix: stageStoragePrefix(ctx, 'describe'),
  });

  if (result.status === 'error') {
    throw new Error(result.message || 'describe stage failed');
  }

  return { message: result.message, data: result.data };
};
