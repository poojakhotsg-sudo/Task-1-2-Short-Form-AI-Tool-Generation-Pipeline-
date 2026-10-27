import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { normalizeVideoFile } from '../services/normalizeMedia.js';
import { probeVideoFull } from '../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);

// Same convention as assembleRoughCut.ffmpeg.test.ts: exercises
// normalizeVideoFile() against the real ffmpeg binary rather than just
// trusting the ported flags, skipping cleanly when ffmpeg isn't on PATH.
let ffmpegAvailable = true;
let tempDir: string;

beforeAll(async () => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
  } catch {
    ffmpegAvailable = false;
  }
  tempDir = await mkdtemp(join(tmpdir(), 'normalize-ffmpeg-test-'));
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function makeClip(
  outPath: string,
  seconds: number,
  opts: { codec?: string; pixFmt?: string; withAudio?: boolean } = {}
): Promise<void> {
  const { codec = 'libx264', pixFmt = 'yuv420p', withAudio = false } = opts;
  // testsrc2 (not a solid color) so the encoded output is large enough
  // to clear normalize_video()'s 50KB "empty clip" threshold at a short
  // test duration.
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=640x480:r=24:d=${seconds}`];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  }
  args.push('-c:v', codec, '-pix_fmt', pixFmt);
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  args.push(outPath);
  await execFileAsync('ffmpeg', args);
}

describe('normalizeVideoFile (real ffmpeg)', () => {
  it('re-encodes a non-h264 source to h264/yuv420p and keeps it (large/long enough)', async () => {
    if (!ffmpegAvailable) return;

    const srcPath = join(tempDir, 'mpeg4.mp4');
    await makeClip(srcPath, 3.0, { codec: 'mpeg4' });

    const outPath = join(tempDir, 'mpeg4-out.mp4');
    const result = await normalizeVideoFile(srcPath, outPath, false);

    expect(result.action).toBe('reencode');
    expect(result.kept).toBe(true);
    const outProbe = await probeVideoFull(outPath);
    expect(outProbe.codec).toBe('h264');
    expect(outProbe.pixFmt).toBe('yuv420p');
  }, 30000);

  it('strips audio from an already-compliant non-embed clip via stream copy', async () => {
    if (!ffmpegAvailable) return;

    const srcPath = join(tempDir, 'with-audio.mp4');
    await makeClip(srcPath, 3.0, { withAudio: true });

    const outPath = join(tempDir, 'with-audio-out.mp4');
    const result = await normalizeVideoFile(srcPath, outPath, false);

    expect(result.action).toBe('strip_audio');
    const outProbe = await probeVideoFull(outPath);
    expect(outProbe.hasAudio).toBe(false);
  }, 30000);

  it('keeps audio on an embed clip and takes the no-op path', async () => {
    if (!ffmpegAvailable) return;

    const srcPath = join(tempDir, 'embed-with-audio.mp4');
    await makeClip(srcPath, 3.0, { withAudio: true });

    const outPath = join(tempDir, 'embed-with-audio-out.mp4');
    const result = await normalizeVideoFile(srcPath, outPath, true);

    expect(result.action).toBe('none');
    const outProbe = await probeVideoFull(outPath);
    expect(outProbe.hasAudio).toBe(true);
  }, 30000);

  it('discards a clip shorter than 1 second (kept: false, no usable output implied)', async () => {
    if (!ffmpegAvailable) return;

    const srcPath = join(tempDir, 'tiny.mp4');
    await makeClip(srcPath, 0.5);

    const outPath = join(tempDir, 'tiny-out.mp4');
    const result = await normalizeVideoFile(srcPath, outPath, false);

    expect(result.kept).toBe(false);
  }, 30000);
});
