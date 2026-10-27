import type { Request, Response } from 'express';
import { runQaRequestSchema, type WorkerTaskResult } from '../../types.js';
import { runQa } from '../../services/runQa.js';
import { uploadObject } from '../../lib/storage.js';

// POST /tasks/run_qa — the HTTP endpoint web-next's
// src/inngest/stages/qa.ts dispatches to via callWorkerTask().
export async function handleRunQa(req: Request, res: Response): Promise<void> {
  const parsed = runQaRequestSchema.safeParse(req.body);
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
    const { report, passCount, failCount } = await runQa(grabStoragePrefix);

    await uploadObject({
      key: `${storagePrefix}qa_report.json`,
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    const result: WorkerTaskResult = {
      status: 'ok',
      message:
        report.length === 0
          ? 'No clips found under the grab stage\'s storage prefix — nothing to check'
          : `${passCount}/${report.length} clip(s) passed QA`,
      data: { qaReportKey: `${storagePrefix}qa_report.json`, passCount, failCount, totalClips: report.length },
    };
    res.status(200).json(result);
  } catch (err) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: err instanceof Error ? err.message : 'run_qa failed with an unknown error',
    };
    res.status(502).json(result);
  }
}
