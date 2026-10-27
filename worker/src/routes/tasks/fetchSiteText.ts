import type { Request, Response } from 'express';
import { fetchSiteTextRequestSchema, type WorkerTaskResult } from '../../types.js';
import { fetchSiteText } from '../../services/siteText.js';
import { uploadObject } from '../../lib/storage.js';

// POST /tasks/fetch_site_text — the HTTP endpoint web-next's
// src/inngest/stages/script.ts dispatches to via callWorkerTask(), to
// get script_gen.py's fetch_site_text() browser-automation output
// without running Playwright inside the Next.js process.
export async function handleFetchSiteText(req: Request, res: Response): Promise<void> {
  const parsed = fetchSiteTextRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
    res.status(400).json(result);
    return;
  }

  const { url, storagePrefix } = parsed.data;

  try {
    const text = await fetchSiteText(url);

    await uploadObject({
      key: `${storagePrefix}site_text.txt`,
      body: text,
      contentType: 'text/plain',
    });

    const result: WorkerTaskResult = {
      status: 'ok',
      message: text ? `Fetched ${text.length} character(s) of site text` : 'No site text could be extracted',
      data: { siteTextKey: `${storagePrefix}site_text.txt`, length: text.length },
    };
    res.status(200).json(result);
  } catch (err) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: err instanceof Error ? err.message : 'fetch_site_text failed with an unknown error',
    };
    res.status(502).json(result);
  }
}
