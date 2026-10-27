import type { Request, Response } from 'express';
import { assembleRoughCutRequestSchema, type WorkerTaskResult } from '../../types.js';
import { assembleRoughCut } from '../../services/assembleRoughCut.js';

// POST /tasks/assemble_rough_cut — the HTTP endpoint web-next's
// src/inngest/stages/assemble.ts dispatches to.
export async function handleAssembleRoughCut(req: Request, res: Response): Promise<void> {
  const parsed = assembleRoughCutRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
    res.status(400).json(result);
    return;
  }

  const { toolName, matchStoragePrefix, storagePrefix, placeholders } = parsed.data;

  try {
    const summary = await assembleRoughCut(toolName, matchStoragePrefix, storagePrefix, placeholders);

    const result: WorkerTaskResult = {
      status: 'ok',
      message: summary.roughCutUploaded
        ? `Assembled rough_cut.mp4 (${summary.shotsCovered}/${summary.shotsTotal} shots covered, ${summary.shotsMissing} missing, ${summary.shotsNeedTrial} needs trial)`
        : 'Nothing to cut — no shots had a clip or a placeholder to fall back to',
      data: {
        roughCutKey: summary.roughCutUploaded ? `${storagePrefix}rough_cut.mp4` : null,
        summaryKey: `${storagePrefix}summary.md`,
        ...summary,
      },
    };
    res.status(200).json(result);
  } catch (err) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: err instanceof Error ? err.message : 'assemble_rough_cut failed with an unknown error',
    };
    res.status(502).json(result);
  }
}
