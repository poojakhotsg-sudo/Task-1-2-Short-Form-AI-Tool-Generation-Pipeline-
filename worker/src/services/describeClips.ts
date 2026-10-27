import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listObjectsUnderPrefix, downloadObject, uploadObject } from '../lib/storage.js';
import { getClipDurationSeconds, extractFramePng } from '../lib/ffmpeg.js';
import { captionClipFrames } from './visionCaption.js';
import type { ClipCatalog } from '../types.js';

// PIPE-03's "grab stage must have already produced clips" assumption:
// this reads them from grabStoragePrefix + 'clips/' (object-storage-
// layout.md's convention for where PIPE-02 writes clipNN_<heading>.mp4
// etc.). Today's capture_site implementation doesn't record clips yet
// (see worker's captureSite.ts) — so running this against real grab
// output will currently find zero clips and return an empty catalog.
// That's the honest, correct behavior given where the pipeline actually
// stands, not a bug in this file.
const FRAME_FRACTIONS = [0.2, 0.5, 0.8]; // PIPE-03: "20%, 50%, and 80% of the clip duration"

export interface DescribeClipsResult {
  catalog: ClipCatalog;
  clipsDescribed: number;
  clipsReused: number;
}

export async function describeClips(
  grabStoragePrefix: string,
  storagePrefix: string
): Promise<DescribeClipsResult> {
  const existingCatalog = await loadExistingCatalog(storagePrefix);
  const clipObjects = await listObjectsUnderPrefix(`${grabStoragePrefix}clips`);

  const catalog: ClipCatalog = { ...existingCatalog };
  let clipsDescribed = 0;
  let clipsReused = 0;

  for (const clip of clipObjects) {
    const filename = clip.key.split('/').pop()!;

    // Reuses existing catalog entries (PIPE-03) — a retried describe
    // stage shouldn't re-caption (and re-spend API calls on) a clip it
    // already cataloged successfully.
    if (catalog[filename]) {
      clipsReused += 1;
      continue;
    }

    catalog[filename] = await describeOneClip(clip.key, filename);
    clipsDescribed += 1;
  }

  await uploadObject({
    key: `${storagePrefix}clip_catalog.json`,
    body: JSON.stringify(catalog, null, 2),
    contentType: 'application/json',
  });

  return { catalog, clipsDescribed, clipsReused };
}

async function loadExistingCatalog(storagePrefix: string): Promise<ClipCatalog> {
  const existing = await downloadObject(`${storagePrefix}clip_catalog.json`);
  if (!existing) return {};
  try {
    return JSON.parse(existing.toString('utf-8')) as ClipCatalog;
  } catch {
    // A corrupt or unexpectedly-shaped prior catalog shouldn't crash the
    // whole stage — re-describing everything is safe (idempotent writes
    // to the same clip keys), just more expensive than reuse would be.
    return {};
  }
}

async function describeOneClip(storageKey: string, filename: string) {
  const clipBytes = await downloadObject(storageKey);
  if (!clipBytes) {
    throw new Error(`Clip object listed but could not be downloaded: ${storageKey}`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'describe-clip-'));
  try {
    const clipPath = join(tempDir, filename);
    await writeFile(clipPath, clipBytes);

    const duration = await getClipDurationSeconds(clipPath);
    const frames: Buffer[] = [];
    for (let i = 0; i < FRAME_FRACTIONS.length; i++) {
      const framePath = join(tempDir, `frame-${i}.png`);
      await extractFramePng(clipPath, duration * FRAME_FRACTIONS[i], framePath);
      frames.push(await readFile(framePath));
    }

    return await captionClipFrames(frames);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
