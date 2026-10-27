import type { Request, Response } from 'express';
import { extractMediaRequestSchema, type WorkerTaskResult } from '../../types.js';
import { extractMedia } from '../../services/extractMedia.js';
import { uploadObject } from '../../lib/storage.js';

// POST /tasks/extract_media — see extractMedia.ts's file-level comment
// for exactly what this covers and what's deliberately not ported yet.
export async function handleExtractMedia(req: Request, res: Response): Promise<void> {
  const parsed = extractMediaRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
    res.status(400).json(result);
    return;
  }

  const { url, storagePrefix, headed } = parsed.data;

  try {
    const { report, manifest, files } = await extractMedia(url, { headed });

    for (const file of files) {
      await uploadObject({ key: `${storagePrefix}${file.path}`, body: file.content, contentType: file.contentType });
    }

    await uploadObject({ key: `${storagePrefix}manifest.json`, body: JSON.stringify({ url, items: manifest }, null, 2), contentType: 'application/json' });
    await uploadObject({ key: `${storagePrefix}report.json`, body: JSON.stringify(report, null, 2), contentType: 'application/json' });

    const result: WorkerTaskResult = {
      status: report.status === 'ok' ? 'ok' : 'error',
      message:
        report.message ||
        `Extracted ${report.counts.videos_gifs} video/gif(s) and ${report.counts.images} image(s)` +
          (report.embedsNotDownloaded > 0 ? ` (${report.embedsNotDownloaded} embed(s) not downloaded)` : ''),
      data: {
        manifestKey: `${storagePrefix}manifest.json`,
        reportKey: `${storagePrefix}report.json`,
        counts: report.counts,
        embedsNotDownloaded: report.embedsNotDownloaded,
        botCheck: report.botCheck,
        // The full manifest, inline — small per-entry metadata (no media
        // bytes), so the caller (web-next's run-extract-job) can populate
        // the `assets` table directly from this response instead of a
        // second storage round-trip to re-download manifest.json.
        manifest: manifest.map((m) => ({ ...m, storageKey: `${storagePrefix}${m.path}`, mp4StorageKey: m.mp4 ? `${storagePrefix}${m.mp4}` : null })),
      },
    };
    res.status(report.status === 'ok' ? 200 : 502).json(result);
  } catch (err) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: err instanceof Error ? err.message : 'extract_media failed with an unknown error',
    };
    res.status(502).json(result);
  }
}
