import type { Request, Response } from 'express';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename, extname } from 'path';
import { normalizeMediaRequestSchema, type WorkerTaskResult } from '../../types.js';
import { normalizeVideoFile } from '../../services/normalizeMedia.js';
import { downloadObject, uploadObject } from '../../lib/storage.js';

// POST /tasks/normalize_media — see normalizeMedia.ts's file-level
// comment: no reel-pipeline stage dispatches this yet, but the contract
// and the ffmpeg work behind it are real.
//
// extract_assets.py's is_embed detection ("embed" in the filename, or an
// "embedded" path segment) ported directly against the storage key,
// since that's this port's equivalent of a filesystem path.
function isEmbedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes('embed') || lower.split('/').includes('embedded');
}

// Sibling .mp4 key in the same "folder" as the original — object-storage-
// layout.md's `assets.mp4_storage_key` convention (e.g. ".../demo.webm"
// -> ".../demo.mp4"), not the source's overwrite-in-place.
function siblingMp4Key(key: string): string {
  const ext = extname(key);
  return ext ? key.slice(0, -ext.length) + '.mp4' : `${key}.mp4`;
}

interface NormalizedShotResult {
  key: string;
  mp4Key: string | null;
  kept: boolean;
  action: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  pixFmt: string | null;
  durationSeconds: number | null;
  hasAudio: boolean;
  error: string | null;
}

export async function handleNormalizeMedia(req: Request, res: Response): Promise<void> {
  const parsed = normalizeMediaRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: `Invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
    res.status(400).json(result);
    return;
  }

  const { keys } = parsed.data;
  const tempDir = await mkdtemp(join(tmpdir(), 'normalize-media-'));

  try {
    const results: NormalizedShotResult[] = [];

    for (const key of keys) {
      try {
        const content = await downloadObject(key);
        if (!content) {
          results.push({
            key, mp4Key: null, kept: false, action: 'none', sizeBytes: null,
            width: null, height: null, codec: null, pixFmt: null, durationSeconds: null, hasAudio: false,
            error: 'object not found',
          });
          continue;
        }

        const inputPath = join(tempDir, `in-${results.length}-${basename(key)}`);
        const outputPath = join(tempDir, `out-${results.length}.mp4`);
        await writeFile(inputPath, content);

        const normalized = await normalizeVideoFile(inputPath, outputPath, isEmbedKey(key));
        const mp4Key = siblingMp4Key(key);

        if (normalized.kept) {
          const outputBytes = await readFile(outputPath);
          await uploadObject({ key: mp4Key, body: outputBytes, contentType: 'video/mp4' });
        }

        results.push({
          key,
          mp4Key: normalized.kept ? mp4Key : null,
          kept: normalized.kept,
          action: normalized.action,
          sizeBytes: normalized.sizeBytes,
          width: normalized.facts.width,
          height: normalized.facts.height,
          codec: normalized.facts.codec,
          pixFmt: normalized.facts.pixFmt,
          durationSeconds: normalized.facts.durationSeconds,
          hasAudio: normalized.facts.hasAudio,
          error: null,
        });
      } catch (err) {
        results.push({
          key, mp4Key: null, kept: false, action: 'none', sizeBytes: null,
          width: null, height: null, codec: null, pixFmt: null, durationSeconds: null, hasAudio: false,
          error: err instanceof Error ? err.message : 'normalize failed with an unknown error',
        });
      }
    }

    const keptCount = results.filter((r) => r.kept).length;
    const discardedCount = results.filter((r) => !r.kept && !r.error).length;

    const result: WorkerTaskResult = {
      status: 'ok',
      message: `Normalized ${keptCount}/${keys.length} clip(s)${discardedCount > 0 ? ` (${discardedCount} too small/short to keep)` : ''}`,
      data: { results, keptCount, discardedCount, totalKeys: keys.length },
    };
    res.status(200).json(result);
  } catch (err) {
    const result: WorkerTaskResult = {
      status: 'error',
      message: err instanceof Error ? err.message : 'normalize_media failed with an unknown error',
    };
    res.status(502).json(result);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
