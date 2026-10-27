import { callWorkerTask } from '@/lib/workerClient';
import type { StageExecutor } from './types';
import { stageStoragePrefix } from './types';

// PIPE-10: upload the tool's outputs to a numbered Google Drive folder,
// via the OAuth desktop flow + DRIVE_FOLDER_ID. Needs the worker's own
// filesystem/credentials access, not this app's — delegates to
// upload_drive.
export const runUploadStage: StageExecutor = async (ctx) => {
  const result = await callWorkerTask('upload_drive', {
    jobId: ctx.jobId,
    toolSlug: ctx.toolSlug,
    toolName: ctx.toolName,
    assembleStoragePrefix: stageStoragePrefix(ctx, 'assemble'),
  });

  if (result.status === 'error') {
    throw new Error(result.message || 'upload stage failed');
  }

  return { message: result.message, data: result.data };
};
