import { stat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { probeVideoFull, type FullVideoProbe } from '../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);

// PIPE-? / EXTRACT-05, ported from extract_assets.py's normalize_video()
// (lines 458-507). No reel-pipeline stage calls this yet — extract_media,
// the task that would produce the raw assets this normalizes, isn't
// built either (see server.ts's comment) — but the HTTP contract and the
// ffmpeg logic are real, not stubbed, so whatever calls it next (or a
// test) gets faithful behavior rather than a placeholder.
//
// One deliberate difference from the source, not a silent one: the
// source re-encodes in place, renaming the re-encoded .mp4 temp file
// over the ORIGINAL path — so a source .webm ends up holding h264/mp4
// container bytes under a .webm extension. object-storage-layout.md
// already decided this port does it differently: write the normalized
// copy to its own sibling `.mp4` key (`assets.mp4_storage_key`) instead
// of overwriting the original object, so a `.webm` asset keeps being a
// real .webm and gets a genuine `.mp4` sibling alongside it. This
// service reflects that: it never touches the input file, and always
// writes its result to a separate output path the caller chooses.

export type NormalizeAction = 'reencode' | 'strip_audio' | 'none';

// Pure decision logic from normalize_video()'s branching (lines 470,
// 489): re-encode if the codec/pixel format aren't already what PIPE-02/
// PIPE-09 assume (h264/yuv420p); otherwise, for a non-embed clip that
// still carries audio, strip it with a cheap stream copy; otherwise
// there's nothing to do.
export function decideNormalizeAction(
  facts: Pick<FullVideoProbe, 'codec' | 'pixFmt' | 'hasAudio'>,
  isEmbed: boolean
): NormalizeAction {
  const codec = (facts.codec || '').toLowerCase();
  const pixFmt = (facts.pixFmt || '').toLowerCase();
  if (codec !== 'h264' || pixFmt !== 'yuv420p') return 'reencode';
  if (!isEmbed && facts.hasAudio) return 'strip_audio';
  return 'none';
}

// Pure decision logic from normalize_video()'s empty-clip check (lines
// 501-503): drop anything under 50KB or shorter than 1 second.
export function shouldDiscard(sizeBytes: number, durationSeconds: number | null): boolean {
  return sizeBytes < 50 * 1024 || (durationSeconds ?? 0) < 1.0;
}

export interface NormalizeVideoResult {
  kept: boolean; // false means the clip was too small/short to keep — no output file was produced
  action: NormalizeAction;
  facts: FullVideoProbe;
  sizeBytes: number | null;
}

// Normalizes `inputPath` into `outputPath` (always ending up h264/
// yuv420p/+faststart, audio-free unless `isEmbed`), matching
// normalize_video()'s exact ffmpeg flags. Returns kept: false (and never
// writes outputPath) when the result is too small/short to be worth
// keeping — the caller is responsible for not uploading anything in
// that case, same as the source deleting the clip outright.
export async function normalizeVideoFile(
  inputPath: string,
  outputPath: string,
  isEmbed: boolean
): Promise<NormalizeVideoResult> {
  let facts = await probeVideoFull(inputPath);
  const action = decideNormalizeAction(facts, isEmbed);

  if (action === 'reencode') {
    const args = ['-y', '-v', 'error', '-i', inputPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    if (!isEmbed) {
      args.push('-an');
    } else if (facts.hasAudio) {
      args.push('-c:a', 'aac', '-b:a', '128k');
    }
    args.push(outputPath);
    await execFileAsync('ffmpeg', args, { timeout: 600000 });
    facts = await probeVideoFull(outputPath);
  } else if (action === 'strip_audio') {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', inputPath, '-c:v', 'copy', '-an', '-movflags', '+faststart', outputPath],
      { timeout: 300000 }
    );
    facts = await probeVideoFull(outputPath);
  } else {
    // Nothing to change, but the caller still wants a file at
    // outputPath (the sibling .mp4 key always gets written when this
    // service runs) — a plain stream copy, no re-encode.
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', outputPath], {
      timeout: 300000,
    });
  }

  let sizeBytes: number | null = null;
  try {
    sizeBytes = (await stat(outputPath)).size;
  } catch {
    sizeBytes = null;
  }

  if (sizeBytes === null || shouldDiscard(sizeBytes, facts.durationSeconds)) {
    return { kept: false, action, facts, sizeBytes };
  }
  return { kept: true, action, facts, sizeBytes };
}
