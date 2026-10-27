import type { Request, Response } from 'express';
import { describeClipsRequestSchema, type WorkerTaskResult } from '../../types.js';
import { describeClips } from '../../services/describeClips.js';

// POST /tasks/describe_clips — the HTTP endpoint web-next's
// src/inngest/stages/describe.ts dispatches to.
export async function handleDescribeClips(req: Request, res: Response): Promise<void> {
  const parsed = describeClipsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
    res.status(400).json(result);
    return;
  }

  const { grabStoragePrefix, storagePrefix } = parsed.data;

  try {
    const { catalog, clipsDescribed, clipsReused } = await describeClips(grabStoragePrefix, storagePrefix);

    const totalClips = Object.keys(catalog).length;
    const result: WorkerTaskResult = {
      status: 'ok',
      message:
        totalClips === 0
          ? 'No clips found under the grab stage\'s storage prefix — nothing to describe'
          : `Described ${clipsDescribed} new clip(s), reused ${clipsReused} existing catalog entr${clipsReused === 1 ? 'y' : 'ies'}`,
      data: {
        catalogKey: `${storagePrefix}clip_catalog.json`,
        clipsDescribed,
        clipsReused,
        totalClips,
      },
    };
    res.status(200).json(result);
  } catch (err) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: err instanceof Error ? err.message : 'describe_clips failed with an unknown error',
    };
    res.status(502).json(result);
  }
}
