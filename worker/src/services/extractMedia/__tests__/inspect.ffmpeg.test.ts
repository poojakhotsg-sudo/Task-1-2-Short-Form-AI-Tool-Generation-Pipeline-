import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { inspectAsset } from '../inspect.js';

const execFileAsync = promisify(execFile);

let ffmpegAvailable = true;
let tempDir: string;

beforeAll(async () => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
  } catch {
    ffmpegAvailable = false;
  }
  tempDir = await mkdtemp(join(tmpdir(), 'extract-inspect-test-'));
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function headOf(path: string, n = 1024): Promise<Buffer> {
  const full = await readFile(path);
  return full.subarray(0, n);
}

describe('inspectAsset (real ffprobe)', () => {
  it('classifies a single-frame PNG as "still" with correct dimensions', async () => {
    if (!ffmpegAvailable) return;

    const path = join(tempDir, 'still.png');
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x48', '-frames:v', '1', path]);

    const { kind, facts } = await inspectAsset(path, '.png', await headOf(path));
    expect(kind).toBe('still');
    expect(facts.width).toBe(64);
    expect(facts.height).toBe(48);
    expect(facts.format).toBe('PNG');
  }, 20000);

  it('classifies a real animated GIF as "animated" with format GIF and frames > 1', async () => {
    if (!ffmpegAvailable) return;

    const path = join(tempDir, 'anim.gif');
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=80x60:r=10:d=1', path]);

    const { kind, facts } = await inspectAsset(path, '.gif', await headOf(path));
    expect(kind).toBe('animated');
    expect(facts.format).toBe('GIF');
    expect(facts.frames).toBeGreaterThan(1);
  }, 20000);

  it('classifies a single-frame GIF as "gif-still"', async () => {
    if (!ffmpegAvailable) return;

    const path = join(tempDir, 'still.gif');
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x48', '-frames:v', '1', path]);

    const { kind, facts } = await inspectAsset(path, '.gif', await headOf(path));
    expect(kind).toBe('gif-still');
    expect(facts.format).toBe('GIF');
  }, 20000);

  it('classifies a real h264 video as "video" with duration', async () => {
    if (!ffmpegAvailable) return;

    const path = join(tempDir, 'clip.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=24:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
    ]);

    const { kind, facts } = await inspectAsset(path, '.mp4', await headOf(path));
    expect(kind).toBe('video');
    expect(facts.durationSeconds).toBeGreaterThan(1.5);
  }, 20000);

  it('classifies raw SVG markup by content sniffing, regardless of extension', async () => {
    const svgBuf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    const path = join(tempDir, 'icon.bin');
    const { writeFile } = await import('fs/promises');
    await writeFile(path, svgBuf);

    const { kind } = await inspectAsset(path, '.bin', svgBuf);
    expect(kind).toBe('svg');
  });

  it('classifies HTML/JSON error-page content as "other"', async () => {
    const htmlBuf = Buffer.from('<!DOCTYPE html><html><body>Not Found</body></html>');
    const path = join(tempDir, 'error.bin');
    const { writeFile } = await import('fs/promises');
    await writeFile(path, htmlBuf);

    const { kind } = await inspectAsset(path, '.bin', htmlBuf);
    expect(kind).toBe('other');
  });
});
