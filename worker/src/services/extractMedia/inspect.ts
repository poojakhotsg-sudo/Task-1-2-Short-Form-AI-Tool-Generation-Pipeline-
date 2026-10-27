import { execFile } from 'child_process';
import { promisify } from 'util';
import { probeVideoFull } from '../../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);

export type InspectKind = 'video' | 'animated' | 'gif-still' | 'still' | 'svg' | 'other';

export interface InspectFacts {
  width: number | null;
  height: number | null;
  frames: number;
  format: string | null;
  durationSeconds: number | null;
}

const EMPTY_FACTS: InspectFacts = { width: null, height: null, frames: 1, format: null, durationSeconds: null };

// extract_assets.py's inspect() (lines 1002-1034), re-based on ffprobe
// instead of PIL — this worker has no Node image library (Section 6's
// "native FFmpeg and ffprobe installed" assumption already covers
// ffprobe; adding Pillow's equivalent would mean a new native
// dependency for a single function). ffprobe decodes the same still-
// image formats PIL does (JPEG/PNG/GIF/WEBP/AVIF, assuming a
// reasonably current ffmpeg build) and reports frame counts for
// animated containers via `-count_frames`, which is what this needs:
// width/height/format/frame-count, not per-frame timing.
//
// A real behavior difference, not silent: the source's GIF-duration/fps
// facts (lines 1021-1026, used only by animated_to_mp4()'s GIF-to-mp4
// conversion) are not computed here, because animated_to_mp4() itself
// isn't ported yet (see extractMedia.ts's file-level comment) — nothing
// reads those facts in this pass.
export async function inspectAsset(path: string, ext: string, contentHead: Buffer): Promise<{ kind: InspectKind; facts: InspectFacts }> {
  const headText = contentHead.toString('latin1').toLowerCase().trimStart();
  if (headText.includes('<svg') || (headText.startsWith('<?xml') && headText.includes('svg'))) {
    return { kind: 'svg', facts: EMPTY_FACTS };
  }
  if (/^(<!doctype|<html|\{|\[)/.test(headText)) {
    return { kind: 'other', facts: EMPTY_FACTS };
  }

  const format = extToFormat(ext);
  if (format) {
    const probe = await probeImageFrames(path);
    if (probe) {
      const facts: InspectFacts = { width: probe.width, height: probe.height, frames: probe.frames, format, durationSeconds: null };
      if (probe.frames > 1) {
        return { kind: 'animated', facts };
      }
      return { kind: format === 'GIF' ? 'gif-still' : 'still', facts };
    }
  }

  const videoProbe = await probeVideoFull(path);
  if (videoProbe.width && (videoProbe.durationSeconds ?? 0) > 0.2) {
    return {
      kind: 'video',
      facts: {
        width: videoProbe.width,
        height: videoProbe.height,
        frames: 1,
        format: (videoProbe.codec || '').toUpperCase() || null,
        durationSeconds: videoProbe.durationSeconds,
      },
    };
  }
  return { kind: 'other', facts: EMPTY_FACTS };
}

function extToFormat(ext: string): string | null {
  const map: Record<string, string> = {
    '.jpg': 'JPEG', '.jpeg': 'JPEG', '.png': 'PNG', '.gif': 'GIF', '.webp': 'WEBP', '.avif': 'AVIF', '.ico': 'ICO',
  };
  return map[ext.toLowerCase()] || null;
}

async function probeImageFrames(path: string): Promise<{ width: number | null; height: number | null; frames: number } | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_read_frames',
      '-of', 'json',
      path,
    ]);
    const data = JSON.parse(stdout) as { streams?: { width?: number; height?: number; nb_read_frames?: string }[] };
    const stream = data.streams?.[0];
    if (!stream) return null;
    const frames = stream.nb_read_frames ? parseInt(stream.nb_read_frames, 10) : 1;
    return {
      width: stream.width ?? null,
      height: stream.height ?? null,
      frames: Number.isFinite(frames) && frames > 0 ? frames : 1,
    };
  } catch {
    return null;
  }
}
