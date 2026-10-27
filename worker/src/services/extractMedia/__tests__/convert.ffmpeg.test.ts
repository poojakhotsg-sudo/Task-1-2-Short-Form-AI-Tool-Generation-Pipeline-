import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { toMp4Video, animatedGifToMp4, animatedToMp4, encodeSegment } from '../convert.js';
import { probeVideoFull, extractGrayscaleFrameRaw } from '../../../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);

let ffmpegAvailable = true;
let tempDir: string;

beforeAll(async () => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
  } catch {
    ffmpegAvailable = false;
  }
  tempDir = await mkdtemp(join(tmpdir(), 'extract-convert-test-'));
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe('toMp4Video (real ffmpeg)', () => {
  it('converts a non-mp4 container into a decodable h264/yuv420p mp4', async () => {
    if (!ffmpegAvailable) return;

    const srcPath = join(tempDir, 'source.webm');
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=24:d=1',
      '-c:v', 'libvpx', srcPath,
    ]);

    const outPath = join(tempDir, 'out.mp4');
    const ok = await toMp4Video(srcPath, outPath);

    expect(ok).toBe(true);
    const probe = await probeVideoFull(outPath);
    expect(probe.codec).toBe('h264');
    expect(probe.pixFmt).toBe('yuv420p');
  }, 30000);

  it('takes the stream-copy path for an already h264/yuv420p/mp4 source', async () => {
    if (!ffmpegAvailable) return;

    const srcPath = join(tempDir, 'already-mp4.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=24:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', srcPath,
    ]);

    const outPath = join(tempDir, 'already-mp4-out.mp4');
    const ok = await toMp4Video(srcPath, outPath);

    expect(ok).toBe(true);
    const probe = await probeVideoFull(outPath);
    expect(probe.codec).toBe('h264');
  }, 30000);
});

describe('animatedGifToMp4 (real ffmpeg)', () => {
  it('converts a real animated GIF to a decodable h264 mp4', async () => {
    if (!ffmpegAvailable) return;

    const gifPath = join(tempDir, 'anim.gif');
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=200x150:r=10:d=1', gifPath]);

    const outPath = join(tempDir, 'anim-out.mp4');
    const ok = await animatedGifToMp4(gifPath, outPath);

    expect(ok).toBe(true);
    const probe = await probeVideoFull(outPath);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBeGreaterThan(0);
  }, 30000);

  it('returns false for a nonexistent source file', async () => {
    if (!ffmpegAvailable) return;

    const ok = await animatedGifToMp4(join(tempDir, 'does-not-exist.gif'), join(tempDir, 'nope.mp4'));
    expect(ok).toBe(false);
  }, 15000);
});

describe('animatedToMp4 (real ffmpeg)', () => {
  it('converts a real animated WebP to a decodable h264 mp4', async () => {
    if (!ffmpegAvailable) return;

    const webpPath = join(tempDir, 'anim.webp');
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=5:d=1',
      '-loop', '0', webpPath,
    ]);

    const outPath = join(tempDir, 'webp-out.mp4');
    const ok = await animatedToMp4(webpPath, outPath);

    expect(ok).toBe(true);
    const probe = await probeVideoFull(outPath);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(64);
  }, 30000);

  it('converts a real animated APNG to a decodable h264 mp4', async () => {
    if (!ffmpegAvailable) return;

    const apngPath = join(tempDir, 'anim.apng');
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=5:d=1',
      '-plays', '0', apngPath,
    ]);

    const outPath = join(tempDir, 'apng-out.mp4');
    const ok = await animatedToMp4(apngPath, outPath);

    expect(ok).toBe(true);
    const probe = await probeVideoFull(outPath);
    expect(probe.codec).toBe('h264');
  }, 30000);

  it('decodes a real AVIF (AV1) source through the same filter chain', async () => {
    if (!ffmpegAvailable) return;

    // This build's AVIF encoder only produces single-frame stills, not
    // a genuine animated sequence (confirmed directly — repeated
    // attempts at a multi-frame encode still probe as nb_read_frames=1),
    // so this can't verify animated-AVIF decoding end to end the way
    // the WebP/APNG tests above do. What it does verify: the exact same
    // ffmpeg command this worker runs for all three formats correctly
    // decodes a real AV1-coded AVIF file (not a mocked/assumed capability)
    // and produces a playable h264 mp4 — the per-frame mechanics are
    // identical for 1 frame or many, since ffmpeg's demuxer/decoder does
    // the frame iteration, not this code.
    const avifPath = join(tempDir, 'still.avif');
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64',
      '-frames:v', '1', '-c:v', 'libaom-av1', avifPath,
    ]);

    const outPath = join(tempDir, 'avif-out.mp4');
    const ok = await animatedToMp4(avifPath, outPath);

    expect(ok).toBe(true);
    const probe = await probeVideoFull(outPath);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(64);
  }, 30000);

  it('composites a semi-transparent animated WebP onto a white background', async () => {
    if (!ffmpegAvailable) return;

    // A fully-transparent black source: if transparency were rendered
    // as black (no compositing), the decoded frame would stay dark;
    // composited onto white, it should come out bright instead.
    const webpPath = join(tempDir, 'transparent.webp');
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=5:d=1',
      '-vf', 'format=rgba,colorchannelmixer=aa=0.0',
      '-loop', '0', webpPath,
    ]);

    const outPath = join(tempDir, 'transparent-out.mp4');
    const ok = await animatedToMp4(webpPath, outPath);
    expect(ok).toBe(true);

    const frame = await extractGrayscaleFrameRaw(outPath, 0, 4, 4);
    const avgBrightness = frame.reduce((sum, v) => sum + v, 0) / frame.length;
    expect(avgBrightness).toBeGreaterThan(200); // near-white (255), not black (0)
  }, 30000);

  it('returns false for a nonexistent source file', async () => {
    if (!ffmpegAvailable) return;

    const ok = await animatedToMp4(join(tempDir, 'does-not-exist.webp'), join(tempDir, 'nope.mp4'));
    expect(ok).toBe(false);
  }, 15000);
});

describe('encodeSegment (real ffmpeg)', () => {
  it('cuts [start, start+dur] of a raw recording into its own mp4, unscaled when size is null', async () => {
    if (!ffmpegAvailable) return;

    const rawPath = join(tempDir, 'raw.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=400x300:r=24:d=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rawPath,
    ]);

    const outPath = join(tempDir, 'segment.mp4');
    const ok = await encodeSegment(rawPath, outPath, 1.0, 2.0, null);

    expect(ok).toBe(true);
    const probe = await probeVideoFull(outPath);
    expect(probe.width).toBe(400);
    expect(probe.durationSeconds).toBeGreaterThan(1.5);
    expect(probe.durationSeconds).toBeLessThan(2.5);
  }, 30000);

  it('scales the output when size is given', async () => {
    if (!ffmpegAvailable) return;

    const rawPath = join(tempDir, 'raw2.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=400x300:r=24:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rawPath,
    ]);

    const outPath = join(tempDir, 'segment-scaled.mp4');
    const ok = await encodeSegment(rawPath, outPath, 0, 1.0, [200, 150]);

    expect(ok).toBe(true);
    const probe = await probeVideoFull(outPath);
    expect(probe.width).toBe(200);
    expect(probe.height).toBe(150);
  }, 30000);

  it('returns false for a nonexistent source file', async () => {
    if (!ffmpegAvailable) return;

    const ok = await encodeSegment(join(tempDir, 'does-not-exist.mp4'), join(tempDir, 'nope.mp4'), 0, 1, null);
    expect(ok).toBe(false);
  }, 15000);
});
