import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listObjectsUnderPrefix, downloadObject } from '../lib/storage.js';
import { checkClip } from './qa/checkClip.js';
import type { QaReportEntry } from '../types.js';

// PIPE-06's run_qa(), scoped to what the worker's /tasks/run_qa endpoint
// actually owns: checking the clips grab produced. qa.py's broader
// manifest-rewriting (shots/clips-map/needs_trial bookkeeping) is
// web-next's job once match.ts exists for real shot assignments — this
// worker just reports facts about each clip file, matching the
// capture_site/describe_clips split already established (the worker
// does native media work and reports results; web-next's Inngest stages
// own the DB/job-state side of things).
export interface RunQaResult {
  report: QaReportEntry[];
  passCount: number;
  failCount: number;
}

export async function runQa(grabStoragePrefix: string): Promise<RunQaResult> {
  const clips = await listObjectsUnderPrefix(`${grabStoragePrefix}clips`);
  const tempDir = await mkdtemp(join(tmpdir(), 'run-qa-'));
  const report: QaReportEntry[] = [];

  try {
    for (const clip of clips) {
      const filename = clip.key.split('/').pop()!;
      const bytes = await downloadObject(clip.key);
      if (!bytes) {
        report.push({
          file: filename,
          seconds: null,
          size: null,
          sharpness: null,
          motion: null,
          ok: false,
          issues: [`clip could not be downloaded (${clip.key})`],
        });
        continue;
      }

      const localPath = join(tempDir, filename);
      await writeFile(localPath, bytes);
      const { metrics, reasons } = await checkClip(localPath);
      report.push({
        file: filename,
        seconds: metrics.seconds,
        size: metrics.size,
        sharpness: metrics.sharpness,
        motion: metrics.motion,
        ok: reasons.length === 0,
        issues: reasons,
      });
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return {
    report,
    passCount: report.filter((r) => r.ok).length,
    failCount: report.filter((r) => !r.ok).length,
  };
}
