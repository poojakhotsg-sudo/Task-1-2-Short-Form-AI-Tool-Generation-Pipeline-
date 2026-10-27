import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Shells out to ffprobe/ffmpeg directly rather than a wrapper package
// (e.g. fluent-ffmpeg) — Section 6 specifies "native FFmpeg and ffprobe
// installed and tested on the worker host," so this assumes both are on
// PATH, same assumption the source Python app made via subprocess.

export async function getClipDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe returned an invalid duration for ${filePath}: ${stdout.trim()}`);
  }
  return seconds;
}

export interface VideoProbe {
  seconds: number;
  width: number;
  height: number;
}

// qa.py's probe(): duration + size via ffprobe, used by checkClip.ts.
export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    filePath,
  ]);
  const info = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const stream = info.streams?.[0];
  const duration = info.format?.duration;
  if (!stream || typeof stream.width !== 'number' || typeof stream.height !== 'number' || !duration) {
    throw new Error(`ffprobe returned incomplete stream info for ${filePath}`);
  }
  return { seconds: parseFloat(duration), width: stream.width, height: stream.height };
}

export interface FullVideoProbe {
  width: number | null;
  height: number | null;
  codec: string | null;
  pixFmt: string | null;
  durationSeconds: number | null;
  hasAudio: boolean;
}

// extract_assets.py's ffprobe() (lines 442-455): the fuller probe
// normalize_media needs (codec/pix_fmt/audio presence), as opposed to
// probeVideo()'s QA-focused width/height/duration. Returns all-null/
// false (never throws) when ffprobe fails or finds no video stream,
// matching the source's bare `except Exception: return {}`.
export async function probeVideoFull(filePath: string): Promise<FullVideoProbe> {
  const empty: FullVideoProbe = { width: null, height: null, codec: null, pixFmt: null, durationSeconds: null, hasAudio: false };
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_streams', '-show_format',
      '-of', 'json',
      filePath,
    ]);
    const data = JSON.parse(stdout) as {
      streams?: { codec_type?: string; width?: number; height?: number; codec_name?: string; pix_fmt?: string }[];
      format?: { duration?: string };
    };
    const streams = data.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    if (!video) return empty;
    const durationRaw = data.format?.duration;
    const duration = durationRaw !== undefined && durationRaw !== null ? parseFloat(durationRaw) : NaN;
    return {
      width: video.width ?? null,
      height: video.height ?? null,
      codec: video.codec_name ?? null,
      pixFmt: video.pix_fmt ?? null,
      durationSeconds: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : null,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
    };
  } catch {
    return empty;
  }
}

// Extracts one frame at `atSeconds`, scaled to exactly width x height,
// as raw 8-bit grayscale pixel bytes (no container, no headers — just
// width*height bytes) via ffmpeg's rawvideo muxer. checkClip.ts's
// sampling loop depends on getting back exactly width*height bytes.
export async function extractGrayscaleFrameRaw(
  filePath: string,
  atSeconds: number,
  width: number,
  height: number
): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-ss', atSeconds.toFixed(3),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', `scale=${width}:${height}`,
      '-pix_fmt', 'gray',
      '-f', 'rawvideo',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 }
  );
  const expected = width * height;
  if (stdout.length !== expected) {
    throw new Error(
      `extractGrayscaleFrameRaw: expected ${expected} bytes, got ${stdout.length} (frame at ${atSeconds}s may not exist)`
    );
  }
  return stdout;
}

export async function extractFramePng(filePath: string, atSeconds: number, outPath: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-ss', atSeconds.toFixed(3),
    '-i', filePath,
    '-frames:v', '1',
    '-y',
    outPath,
  ]);
}

// grabber.py's cut_clip(): slices [start, end] out of a continuous
// session recording (the webm Playwright produced) into its own
// 1080x1920 h264 clip. Ported with the exact same ffmpeg flags
// (scale/fps/preset/crf/pix_fmt/faststart, no audio) rather than
// approximated — these specific settings are what PIPE-02/PIPE-09
// assume downstream.
export async function cutClipToVertical(
  webmPath: string,
  startSeconds: number,
  endSeconds: number,
  outPath: string,
  maxSeconds: number
): Promise<void> {
  const duration = Math.min(endSeconds - startSeconds, maxSeconds + 0.5);
  await execFileAsync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-ss', startSeconds.toFixed(2),
      '-i', webmPath,
      '-t', duration.toFixed(2),
      '-vf', 'scale=1080:1920:flags=lanczos,fps=30',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-an',
      outPath,
    ],
    { timeout: 180000 }
  );
}

// assembler.py's `_ffmpeg()` wrapper: `-y -loglevel error` + a timeout,
// reused across assembleRoughCut.ts's trim/placeholder/concat calls.
export async function runFfmpeg(args: string[], timeoutMs = 300000): Promise<void> {
  await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { timeout: timeoutMs });
}
