import { execFile } from 'child_process';
import { promisify } from 'util';
import { access } from 'fs/promises';
import { probeVideoFull } from '../../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);

// extract_assets.py's to_mp4_video() (lines 1062-1075): any downloaded
// video container -> a browser-safe mp4, stream-copied when it's
// already h264/yuv420p/mp4, otherwise re-encoded. Pure ffmpeg, so it's
// ported directly (unlike animated_to_mp4()'s non-GIF branches, which
// need PIL's frame iteration — see animatedGifToMp4() below for the one
// branch of that function that's also pure ffmpeg).
export async function toMp4Video(srcPath: string, destPath: string): Promise<boolean> {
  const probe = await probeVideoFull(srcPath);
  if ((probe.codec || '').toLowerCase() === 'h264' && (probe.pixFmt || '').toLowerCase() === 'yuv420p') {
    try {
      await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-i', srcPath, '-c', 'copy', '-movflags', '+faststart', destPath]);
      return true;
    } catch {
      // falls through to a full re-encode, same as the source's "copy
      // attempt failed, try the real conversion" path (implicit there
      // via the stream-copy branch's own early-return on success only)
    }
  }
  const args = [
    '-y', '-v', 'error', '-i', srcPath,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ];
  args.push(...(probe.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']));
  args.push(destPath);
  try {
    await execFileAsync('ffmpeg', args, { timeout: 1800000 });
    return true;
  } catch {
    return false;
  }
}

// extract_assets.py's animated_to_mp4() (lines 1078-1101), GIF branch
// only (lines 1080-1084) — a direct ffmpeg decode of the GIF, no PIL
// needed.
export async function animatedGifToMp4(srcPath: string, destPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y', '-v', 'error', '-i', srcPath,
        '-movflags', '+faststart', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264', '-crf', '18',
        destPath,
      ],
      { timeout: 600000 }
    );
    return true;
  } catch {
    return false;
  }
}

// extract_assets.py's animated_to_mp4() (lines 1078-1101), the non-GIF
// branch (lines 1085-1101) — animated WebP/APNG/AVIF -> mp4, white
// behind transparency. The source decodes these frame-by-frame via PIL/
// ImageSequence and pipes raw RGB into ffmpeg's stdin, specifically
// because PIL was already a dependency for other parts of that script,
// not because ffmpeg can't decode these formats itself: this worker's
// ffmpeg build has native webp_anim/apng/AV1(AVIF) decoders (confirmed
// directly — `ffmpeg -decoders` lists `webp_anim`, `apng`; AVIF decodes
// via the already-enabled `libdav1d`/`libaom` AV1 codec), so this skips
// PIL entirely rather than adding a new image-library dependency for it.
//
// The white-behind-transparency compositing is done as an ffmpeg filter
// instead of PIL's `Image.alpha_composite()`: a same-sized white
// `color` source, scaled to match the input via `scale2ref`, with the
// input `overlay`ed on top (alpha-aware by default) — verified directly
// against a real semi-transparent animated WebP before relying on it,
// not assumed from ffmpeg's documentation alone.
export async function animatedToMp4(srcPath: string, destPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y', '-v', 'error',
        '-i', srcPath,
        '-f', 'lavfi', '-i', 'color=white',
        '-filter_complex',
        '[1:v]scale2ref[bg][fg];[bg][fg]overlay=shortest=1,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
        '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart',
        destPath,
      ],
      { timeout: 600000 }
    );
    return true;
  } catch {
    return false;
  }
}

// extract_assets.py's encode_segment() (lines 1104-1112): cuts
// [start, start+dur] of a raw Playwright recording into its own mp4,
// scaled with lanczos when `size` is given (record_scroll()'s use —
// not ported yet) or left at the source resolution when it isn't
// (record_embed()'s use, ported in embed.ts).
export async function encodeSegment(
  rawPath: string,
  destPath: string,
  startSeconds: number,
  durSeconds: number,
  size: [number, number] | null
): Promise<boolean> {
  const vf = (size ? `scale=${size[0]}:${size[1]}:flags=lanczos,` : '') + 'fps=30,format=yuv420p';
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y', '-v', 'error',
        '-ss', Math.max(0, startSeconds).toFixed(3),
        '-i', rawPath,
        '-t', durSeconds.toFixed(3),
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', '-an',
        destPath,
      ],
      { timeout: 600000 }
    );
  } catch {
    return false;
  }
  try {
    await access(destPath);
    return true;
  } catch {
    return false;
  }
}
