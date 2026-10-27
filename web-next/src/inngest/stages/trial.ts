import { callWorkerTask } from '@/lib/workerClient';
import type { StageExecutor } from './types';
import { stageStoragePrefix } from './types';

// PIPE-07: perform a shot's trial_steps inside the signed-in tool and
// record the result — needs Playwright + a saved auth_<tool>.json
// session, so this delegates to the worker. Uses 'record_trial_steps',
// a task name not in Section 5's explicit list (see workerClient.ts's
// comment on why it's there anyway).
export const runTrialStage: StageExecutor = async (ctx) => {
  const result = await callWorkerTask('record_trial_steps', {
    jobId: ctx.jobId,
    toolSlug: ctx.toolSlug,
    matchStoragePrefix: stageStoragePrefix(ctx, 'match'),
    storagePrefix: stageStoragePrefix(ctx, 'trial'),
  });

  if (result.status === 'error') {
    throw new Error(result.message || 'trial stage failed');
  }

  return { message: result.message, data: result.data };
};
