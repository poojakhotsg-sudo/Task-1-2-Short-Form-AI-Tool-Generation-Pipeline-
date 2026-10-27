import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm, readFile as readFileAsync } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, type Server } from 'http';
import { downloadHls } from '../hls.js';
import { probeVideoFull } from '../../../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);

let ffmpegAvailable = true;
let tempDir: string;
let server: Server;
let baseUrl: string;

// downloadHls()'s ffmpeg-remux path uses ffmpeg's `-headers` option,
// which only applies to network protocols (http/https) — ffmpeg
// rejects it outright for a local file input ("Option headers not
// found"). A real local HTTP server (not a mock) is the only way to
// exercise that path genuinely, same spirit as this project's other
// "real ffmpeg, not mocked" tests.
beforeAll(async () => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
  } catch {
    ffmpegAvailable = false;
  }
  tempDir = await mkdtemp(join(tmpdir(), 'extract-hls-test-'));

  server = createServer(async (req, res) => {
    try {
      const filePath = join(tempDir, 'hls-src', (req.url || '/').replace(/^\//, ''));
      const body = await readFileAsync(filePath);
      res.writeHead(200);
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Builds a real local HLS playlist (.m3u8 + .ts segments) via ffmpeg's
// own HLS muxer — downloadHls()'s ffmpeg-remux path reads this exactly
// as it would read a remote .m3u8 URL (ffmpeg's `-i` takes a local path
// the same way it takes an http(s) URL; the `-headers` flag is simply
// unused for a local input, same as it would be for yt-dlp given a
// local path — no HTTP server needed for this test).
async function makeLocalHlsPlaylist(dir: string): Promise<string> {
  const playlistPath = join(dir, 'stream.m3u8');
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=24:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0',
    '-hls_segment_filename', join(dir, 'seg%d.ts'),
    playlistPath,
  ]);
  return playlistPath;
}

describe('downloadHls (real ffmpeg)', () => {
  it('remuxes a real HLS playlist into a playable mp4 via the ffmpeg path', async () => {
    if (!ffmpegAvailable) return;

    const subDir = join(tempDir, 'hls-src');
    const { mkdir } = await import('fs/promises');
    await mkdir(subDir);
    await makeLocalHlsPlaylist(subDir);

    const outDir = join(tempDir, 'hls-out');
    await mkdir(outDir);
    const result = await downloadHls(`${baseUrl}/stream.m3u8`, outDir, 'clip', 'https://example.com', 'test-agent');

    expect('content' in result).toBe(true);
    if ('content' in result) {
      expect(result.ext).toBe('.mp4');
      const outPath = join(outDir, 'probe.mp4');
      const { writeFile } = await import('fs/promises');
      await writeFile(outPath, result.content);
      const probe = await probeVideoFull(outPath);
      expect(probe.width).toBe(160);
      expect(probe.durationSeconds).toBeGreaterThan(1);
    }
  }, 30000);

  it('falls back and reports an error when both ffmpeg and yt-dlp cannot handle the source', async () => {
    const outDir = join(tempDir, 'hls-fail');
    const { mkdir } = await import('fs/promises');
    await mkdir(outDir);

    const result = await downloadHls('https://example.invalid/does-not-exist.m3u8', outDir, 'clip', 'https://example.com', 'test-agent');

    expect('error' in result).toBe(true);
  }, 60000);
});
