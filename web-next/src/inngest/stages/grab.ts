import { callWorkerTask } from '@/lib/workerClient';
import type { StageExecutor } from './types';
import { stageStoragePrefix } from './types';

// PIPE-02: scan the site at 1080x1920, record section clips, pull site
// data (headings, feature text, embedded video URLs). Delegates to the
// worker's capture_site task — this executor's job is just the HTTP call
// and mapping its result, not the actual Playwright/ffmpeg work.
export const runGrabStage: StageExecutor = async (ctx) => {
  const result = await callWorkerTask('capture_site', {
    jobId: ctx.jobId,
    toolSlug: ctx.toolSlug,
    url: ctx.url,
    headed: ctx.headed ?? false,
    storagePrefix: stageStoragePrefix(ctx, 'grab'),
  });

  if (result.status === 'error') {
    throw new Error(result.message || 'grab stage failed');
  }

  return { message: result.message, data: result.data };
};
