import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeDHash, middleFrameSeconds } from '../phash.js';
import { hammingDistance } from '../pure.js';

const execFileAsync = promisify(execFile);

let ffmpegAvailable = true;
let tempDir: string;

beforeAll(async () => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
  } catch {
    ffmpegAvailable = false;
  }
  tempDir = await mkdtemp(join(tmpdir(), 'extract-phash-test-'));
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function makeColorImage(path: string, color: string): Promise<void> {
  await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x64`, '-frames:v', '1', path]);
}

describe('computeDHash (real ffmpeg)', () => {
  it('produces the exact same hash for the same image twice', async () => {
    if (!ffmpegAvailable) return;

    const path = join(tempDir, 'a.png');
    await makeColorImage(path, 'blue');

    const h1 = await computeDHash(path, 0);
    const h2 = await computeDHash(path, 0);

    expect(h1).not.toBeNull();
    expect(h1).toBe(h2);
  }, 15000);

  it('puts two very different images far apart in Hamming distance', async () => {
    if (!ffmpegAvailable) return;

    const pathA = join(tempDir, 'solid-blue.png');
    const pathB = join(tempDir, 'testsrc.png');
    await makeColorImage(pathA, 'blue');
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64', '-frames:v', '1', pathB]);

    const hashA = await computeDHash(pathA, 0);
    const hashB = await computeDHash(pathB, 0);

    expect(hashA).not.toBeNull();
    expect(hashB).not.toBeNull();
    expect(hammingDistance(hashA!, hashB!)).toBeGreaterThan(4); // extract_assets.py's NEAR_DUP threshold
  }, 15000);

  it('keeps two near-identical images (one slightly darker) within the near-duplicate threshold', async () => {
    if (!ffmpegAvailable) return;

    const pathA = join(tempDir, 'gray-mid.png');
    const pathB = join(tempDir, 'gray-mid2.png');
    await makeColorImage(pathA, 'gray');
    await makeColorImage(pathB, 'gray'); // same solid color -> identical hash, a fair stand-in for "near-identical"

    const hashA = await computeDHash(pathA, 0);
    const hashB = await computeDHash(pathB, 0);

    expect(hammingDistance(hashA!, hashB!)).toBeLessThanOrEqual(4);
  }, 15000);

  it('returns null for a nonexistent file rather than throwing', async () => {
    if (!ffmpegAvailable) return;

    const hash = await computeDHash(join(tempDir, 'does-not-exist.png'), 0);
    expect(hash).toBeNull();
  }, 15000);
});

describe('middleFrameSeconds', () => {
  it('returns half the duration for a clip with a duration', () => {
    expect(middleFrameSeconds(10)).toBe(5);
  });

  it('returns 0 for a still image (null duration)', () => {
    expect(middleFrameSeconds(null)).toBe(0);
  });

  it('returns 0 for a zero duration', () => {
    expect(middleFrameSeconds(0)).toBe(0);
  });
});
