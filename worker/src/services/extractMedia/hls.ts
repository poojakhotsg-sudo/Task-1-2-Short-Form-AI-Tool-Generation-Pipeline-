import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export interface HlsDownloadResult {
  ext: string;
  content: Buffer;
}

export interface HlsDownloadError {
  error: string;
}

// extract_assets.py's download_hls() (lines 880-891): ffmpeg remux
// first (fast, no re-encode — works for most plain HLS streams), yt-dlp
// as the fallback (handles DRM-adjacent segmenting, master-playlist
// variant selection, etc. ffmpeg's demuxer can choke on). Ported
// against the already-installed `yt-dlp` CLI (this worker shells out to
// it the same way siteText.ts's embedInfo() does) rather than Python's
// `yt_dlp` library import — there is no Node equivalent to import.
export async function downloadHls(
  url: string,
  tempDir: string,
  stem: string,
  referer: string,
  userAgent: string
): Promise<HlsDownloadResult | HlsDownloadError> {
  const mp4Path = join(tempDir, `${stem}.mp4`);
  const headers = `Referer: ${referer}\r\nUser-Agent: ${userAgent}\r\n`;

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error',
        '-headers', headers,
        '-i', url,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', '+faststart',
        mp4Path,
      ],
      { timeout: 300000 }
    );
    const size = await fileSizeOrZero(mp4Path);
    if (size > 10000) {
      return { ext: '.mp4', content: await readFile(mp4Path) };
    }
  } catch {
    // matches the source's "ffmpeg hls failed" / "timed out" — falls
    // through to yt-dlp either way, not a fatal error on its own
  }
  await unlink(mp4Path).catch(() => {}); // clear a too-small/failed remux before yt-dlp writes its own output

  return downloadViaYtdlp(url, tempDir, stem, referer);
}

async function fileSizeOrZero(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

// extract_assets.py's ytdlp() (lines 907-926), against the yt-dlp CLI.
// Exported — reused directly by embed.ts's downloadOrRecordEmbed() for
// the exact same reason the source reuses this one function from both
// download_hls() and download_all()'s embed loop.
export async function downloadViaYtdlp(
  url: string,
  tempDir: string,
  stem: string,
  referer: string
): Promise<HlsDownloadResult | HlsDownloadError> {
  const outputTemplate = join(tempDir, `${stem}.%(ext)s`);
  try {
    await execFileAsync(
      'yt-dlp',
      [
        '--quiet', '--no-warnings', '--no-progress', '--no-playlist',
        '--playlist-items', '1',
        '--socket-timeout', '20',
        '--retries', '2',
        '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b',
        '--merge-output-format', 'mp4',
        '--add-header', `Referer:${referer}`,
        '-o', outputTemplate,
        url,
      ],
      { timeout: 120000 }
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'yt-dlp failed' };
  }

  let entries: string[];
  try {
    entries = await readdir(tempDir);
  } catch {
    return { error: 'yt-dlp produced no file' };
  }
  const hits = entries.filter((name) => {
    if (!name.startsWith(`${stem}.`)) return false;
    const suffix = name.slice(stem.length);
    return !['.part', '.ytdl', '.json', '.title'].some((ext) => suffix.startsWith(ext));
  });
  if (hits.length === 0) return { error: 'yt-dlp produced no file' };

  let biggest: { name: string; size: number } | null = null;
  for (const name of hits) {
    const size = await fileSizeOrZero(join(tempDir, name));
    if (!biggest || size > biggest.size) biggest = { name, size };
  }
  if (!biggest) return { error: 'yt-dlp produced no file' };

  const ext = biggest.name.slice(stem.length);
  return { ext, content: await readFile(join(tempDir, biggest.name)) };
}
