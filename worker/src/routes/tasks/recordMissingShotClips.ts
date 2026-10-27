import type { Request, Response } from 'express';
import { recordMissingShotClipsRequestSchema, type WorkerTaskResult } from '../../types.js';
import { recordMissingShotClips } from '../../services/recordMissingShotClips.js';
import { uploadObject } from '../../lib/storage.js';

// POST /tasks/record_missing_shot_clips — the HTTP endpoint web-next's
// src/inngest/stages/match.ts dispatches to via callWorkerTask(), for
// any website-sourced shot Rules 1/1b/2 couldn't match to an existing
// clip.
export async function handleRecordMissingShotClips(req: Request, res: Response): Promise<void> {
  const parsed = recordMissingShotClipsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
    res.status(400).json(result);
    return;
  }

  const { url, storagePrefix, headed, shots } = parsed.data;

  try {
    const recorded = await recordMissingShotClips(url, shots, { headed });

    for (const r of recorded) {
      if (r.file && r.content) {
        await uploadObject({ key: `${storagePrefix}clips/${r.file}`, body: r.content, contentType: 'video/mp4' });
      }
    }

    const shotResults = recorded.map((r) => ({
      shot: r.shot,
      file: r.file ? `${storagePrefix}clips/${r.file}` : null,
      status: r.status,
      error: r.error,
      seconds: r.seconds,
      qa: r.qa,
      qaReasons: r.qaReasons,
      matchedHeading: r.matchedHeading,
    }));

    const recordedCount = shotResults.filter((s) => s.status === 'ok').length;

    const result: WorkerTaskResult = {
      status: 'ok',
      message:
        shots.length === 0
          ? 'No pending shots to record'
          : `Recorded ${recordedCount}/${shots.length} mobile clip(s)`,
      data: { shots: shotResults, recordedCount, totalPending: shots.length },
    };
    res.status(200).json(result);
  } catch (err) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: err instanceof Error ? err.message : 'record_missing_shot_clips failed with an unknown error',
    };
    res.status(502).json(result);
  }
}
