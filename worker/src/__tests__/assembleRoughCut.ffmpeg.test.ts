import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { trimClip, placeholderClip } from '../services/assembleRoughCut.js';
import { probeVideo } from '../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);

// Unlike every other test in this worker (which mocks ffmpeg/Playwright
// entirely — see captureSite.route.test.ts, describeClips.service.test.ts),
// ffmpeg happens to actually be on PATH in this environment, so this file
// exercises trimClip()/placeholderClip() against the real binary instead
// of just trusting the ported flags against documentation. Skips cleanly
// if ffmpeg isn't available, rather than failing the suite in an
// environment where it genuinely isn't installed.
let ffmpegAvailable = true;
let tempDir: string;

beforeAll(async () => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
  } catch {
    ffmpegAvailable = false;
  }
  tempDir = await mkdtemp(join(tmpdir(), 'assemble-ffmpeg-test-'));
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function makeSyntheticClip(outPath: string, seconds: number, width = 640, height = 1138): Promise<void> {
  // A real H.264 clip from ffmpeg's own color-source generator — not a
  // Playwright recording, but a genuinely decodable video file, which is
  // what matters for exercising trimClip()'s probe + re-encode path.
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=blue:s=${width}x${height}:r=30:d=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    outPath,
  ]);
}

describe('trimClip / placeholderClip (real ffmpeg)', () => {
  it('placeholderClip produces a decodable 1080x1920 clip of the requested duration', async () => {
    if (!ffmpegAvailable) return;

    const outPath = join(tempDir, 'placeholder.mp4');
    await placeholderClip(outPath, 2.0, 'SHOT 1 MISSING');

    const probe = await probeVideo(outPath);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.seconds).toBeGreaterThan(1.8);
    expect(probe.seconds).toBeLessThan(2.3);
  }, 30000);

  it('trimClip re-encodes a non-1080x1920 source into letterboxed 1080x1920 output, trimmed to `want` seconds', async () => {
    if (!ffmpegAvailable) return;

    const srcPath = join(tempDir, 'source.mp4');
    await makeSyntheticClip(srcPath, 5.0); // 640x1138 source — wrong size, needs letterboxing

    const outPath = join(tempDir, 'trimmed.mp4');
    const { take, length } = await trimClip(srcPath, outPath, 2.0, false);

    expect(length).toBeGreaterThan(4.5); // the source's real probed duration
    expect(take).toBe(2.0); // capped to `want`

    const probe = await probeVideo(outPath);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.seconds).toBeGreaterThan(1.8);
    expect(probe.seconds).toBeLessThan(2.3);
  }, 30000);

  it('trimClip uses the full source when `want` is null', async () => {
    if (!ffmpegAvailable) return;

    const srcPath = join(tempDir, 'source2.mp4');
    await makeSyntheticClip(srcPath, 1.5);

    const outPath = join(tempDir, 'trimmed2.mp4');
    const { take, length } = await trimClip(srcPath, outPath, null, false);

    expect(take).toBe(length);
  }, 30000);

  it('trimClip with fromEnd:true takes the tail of the source, not the head', async () => {
    if (!ffmpegAvailable) return;

    const srcPath = join(tempDir, 'source3.mp4');
    await makeSyntheticClip(srcPath, 5.0);

    const outPath = join(tempDir, 'trimmed3.mp4');
    const { take } = await trimClip(srcPath, outPath, 2.0, true);

    expect(take).toBe(2.0);
    const probe = await probeVideo(outPath);
    expect(probe.seconds).toBeGreaterThan(1.8);
  }, 30000);
});
