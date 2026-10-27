import type { Request, Response } from 'express';
import { captureSiteRequestSchema, type WorkerTaskResult } from '../../types.js';
import { captureSite } from '../../services/captureSite.js';
import { uploadObject } from '../../lib/storage.js';

// POST /tasks/capture_site — the HTTP endpoint web-next's
// src/inngest/stages/grab.ts dispatches to via callWorkerTask(). Request/
// response shapes are the contract both sides agree on (see types.ts's
// comment on why there's no shared package yet).
export async function handleCaptureSite(req: Request, res: Response): Promise<void> {
  const parsed = captureSiteRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
    res.status(400).json(result);
    return;
  }

  const { url, headed, storagePrefix } = parsed.data;

  try {
    const capture = await captureSite(url, { headed });

    await uploadObject({ key: `${storagePrefix}hero.png`, body: capture.heroPng, contentType: 'image/png' });
    await uploadObject({
      key: `${storagePrefix}site_data.json`,
      body: JSON.stringify(capture.siteData, null, 2),
      contentType: 'application/json',
    });

    // object-storage-layout.md's convention: clip files live under
    // this stage's own 'clips/' subfolder — the same path match.ts's
    // Rule 1b and describe_clips' clip listing both expect.
    for (const clip of capture.clips) {
      await uploadObject({ key: `${storagePrefix}clips/${clip.file}`, body: clip.content, contentType: 'video/mp4' });
    }

    // A library.json summary — the clip-level metadata (section/text/
    // position/duration, plus this pass's own QA result from the
    // PIPE-06 static-clip retry check) that describe_clips and match.ts's
    // Rule 3 would read if Rule 3 were ported (it isn't yet — see
    // match.ts's own comment on why). Written even when empty, same
    // honesty convention as describe_clips' clip_catalog.json.
    const library = capture.clips.map((clip) => ({
      file: `clips/${clip.file}`,
      section: clip.section,
      text: clip.text,
      y: clip.y,
      h: clip.h,
      hasVideo: clip.hasVideo,
      seconds: clip.seconds,
      qa: clip.qa,
      qaReasons: clip.qaReasons,
      retried: clip.retried,
    }));
    await uploadObject({
      key: `${storagePrefix}library.json`,
      body: JSON.stringify(library, null, 2),
      contentType: 'application/json',
    });

    const errorSuffix =
      capture.clipErrors.length > 0
        ? `; ${capture.clipErrors.length} section(s) failed to record (${capture.clipErrors.map((e) => e.section).join(', ')})`
        : '';
    const qaPassCount = capture.clips.filter((c) => c.qa === 'pass').length;

    const result: WorkerTaskResult = {
      status: 'ok',
      message: `Captured hero screenshot, site data, and ${capture.clipsRecorded} section clip(s) (${qaPassCount}/${capture.clipsRecorded} passed QA)${errorSuffix}`,
      data: {
        heroKey: `${storagePrefix}hero.png`,
        siteDataKey: `${storagePrefix}site_data.json`,
        libraryKey: `${storagePrefix}library.json`,
        clipsRecorded: capture.clipsRecorded,
        qaPassCount,
        clipErrors: capture.clipErrors,
      },
    };
    res.status(200).json(result);
  } catch (err) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: err instanceof Error ? err.message : 'capture_site failed with an unknown error',
    };
    res.status(502).json(result);
  }
}
