import { guessExt } from './pure.js';
import { MAX_BYTES } from './constants.js';
import { downloadHls } from './hls.js';

export interface DownloadResult {
  ext: string;
  content: Buffer;
}

export interface DownloadError {
  error: string;
}

// extract_assets.py's download() (lines 835-877): data: URLs, HLS
// (.m3u8 URL, or a response that turns out to be an HLS manifest
// despite the URL not ending in .m3u8) via downloadHls(), and a plain
// HTTP GET otherwise.
export async function downloadAsset(
  url: string,
  referer: string,
  cookieHeader: string,
  userAgent: string,
  ctHint: string,
  tempDir: string,
  stem: string
): Promise<DownloadResult | DownloadError> {
  if (url.startsWith('data:')) {
    return downloadDataUrl(url);
  }

  const urlExtIsM3u8 = url.toLowerCase().split('?')[0].endsWith('.m3u8');
  if (urlExtIsM3u8 || ctHint.includes('mpegurl')) {
    return downloadHls(url, tempDir, stem, referer, userAgent);
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': userAgent, Referer: referer, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.name || err.message : 'fetch failed' };
  }

  if (resp.status >= 400) {
    return { error: `HTTP ${resp.status}` };
  }

  const ct = resp.headers.get('content-type') || '';
  if (ct.toLowerCase().includes('mpegurl')) {
    return downloadHls(url, tempDir, stem, referer, userAgent);
  }

  const ext = guessExt(url, ct);
  const body = resp.body;
  if (!body) {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_BYTES) return { error: 'over 500 MB' };
    return { ext, content: buf };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        return { error: 'over 500 MB' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { ext, content: Buffer.concat(chunks) };
}

function downloadDataUrl(url: string): DownloadResult | DownloadError {
  try {
    const commaIdx = url.indexOf(',');
    const header = url.slice(5, commaIdx); // after "data:"
    const payload = url.slice(commaIdx + 1);
    const isSvg = header.toLowerCase().includes('svg');
    const ext = isSvg ? '.svg' : '.png';
    let content: Buffer;
    if (header.toLowerCase().includes(';base64')) {
      content = Buffer.from(payload, 'base64');
    } else {
      content = Buffer.from(decodeURIComponent(payload), 'utf-8');
    }
    if (content.length > MAX_BYTES) return { error: 'over 500 MB' };
    return { ext, content };
  } catch (err) {
    return { error: `data_url_error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
