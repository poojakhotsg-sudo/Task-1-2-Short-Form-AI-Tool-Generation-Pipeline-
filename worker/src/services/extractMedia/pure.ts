// Pure, I/O-free pieces of extract_assets.py's asset-extraction pipeline
// (EXTRACT-* numbering in AUDIT.md), ported so they're directly
// unit-testable without a browser or ffmpeg — same split used
// throughout this project (pageSections.ts, headingMatch.ts, etc.).

export const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.m3u8'];
export const SEGMENT_RE = /\.(ts|m4s|m4a|aac|mp3|vtt|key)(\?|$)|\/seg(ment)?[-_]?\d+|[?&](range|bytestart)=/i;
export const FAVICON_RE = /favicon|apple-touch-icon|mstile|android-chrome-\d+|\/icons?\/|\.ico(\?|$)/i;
export const TRACKING_RE = /pixel|beacon|\/collect\?|facebook\.com\/tr|doubleclick|analytics|\/track/i;
export const BOT_RE =
  /verify you are human|are you a robot|checking your browser|attention required|access denied|captcha|unusual traffic|just a moment/i;

export const CT_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/apng': '.png', 'image/svg+xml': '.svg', 'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'video/ogg': '.ogv', 'application/vnd.apple.mpegurl': '.m3u8', 'application/x-mpegurl': '.m3u8',
};

// extract_assets.py's slug() (lines 412-418): lowercase, ascii-fold,
// non-alnum runs -> '-', capped at `limit` chars without cutting a word
// in half when a hyphen exists past the midpoint.
export function slug(text: string, limit = 30): string {
  let normalized = (text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics, JS's analogue of Python's ascii-encode/ignore
    .replace(/[^\x00-\x7F]/g, ''); // drop anything non-ASCII that survived (emoji, CJK, etc.)
  let out = normalized.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (out.length > limit) {
    const cut = out.slice(0, limit);
    const tail = cut.slice(Math.floor(limit / 2));
    out = tail.includes('-') ? cut.slice(0, cut.lastIndexOf('-')) : cut;
  }
  out = out.replace(/^-+|-+$/g, '');
  return out || 'section';
}

export interface HeadingMark {
  y: number;
  text: string;
}

// extract_assets.py's section_for() (lines 421-427): which heading an
// asset at page-y `y` belongs under.
export function sectionFor(y: number | null, headings: HeadingMark[], fold = 844): string {
  if (y === null) return 'page';
  const above = headings.filter((h) => h.y <= y + 40);
  if (above.length === 0) return y < fold ? 'hero' : 'section';
  return slug(above[above.length - 1].text);
}

// extract_assets.py's guess_ext() (lines 514-518).
export function guessExt(url: string, ct = ''): string {
  let ext = '';
  try {
    ext = new URL(url).pathname.toLowerCase();
    const m = ext.match(/\.[a-z0-9]+$/);
    ext = m ? m[0] : '';
  } catch {
    ext = '';
  }
  if (/^\.[a-z0-9]{2,5}$/.test(ext)) {
    return ext === '.jpeg' ? '.jpg' : ext;
  }
  const mime = (ct || '').split(';')[0].trim().toLowerCase();
  return CT_EXT[mime] || '.bin';
}

// extract_assets.py's is_video_url() (lines 521-525).
export function isVideoUrl(url: string, ct = ''): boolean {
  const ctl = (ct || '').toLowerCase();
  if (SEGMENT_RE.test(url) || ctl.includes('iso.segment') || ctl.includes('mp2t')) return false;
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  return VIDEO_EXT.some((ext) => path.endsWith(ext)) || ctl.startsWith('video/') || ctl.includes('mpegurl');
}

// Query params that only change size/format/tracking — extract_assets.py's
// VARIANT_PARAMS (line 665-666).
const VARIANT_PARAMS = /^(w|h|width|height|q|quality|fm|format|auto|fit|crop|dpr|s|size|resize|utm_\w+|v|ver|version|cb|_)$/i;

export type AssetKey = readonly [host: string, path: string, query: readonly (readonly [string, string])[]];

// extract_assets.py's asset_key() (lines 669-672).
export function assetKey(url: string): AssetKey {
  let host = '';
  let path = '';
  let params: [string, string][] = [];
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
    params = Array.from(u.searchParams.entries());
  } catch {
    // matches Python's urlparse, which never throws on a malformed URL —
    // an unparseable candidate just keys on empty host/path/query
  }
  const query = params
    .filter(([k]) => !VARIANT_PARAMS.test(k))
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return [host, path, query] as const;
}

export interface Candidate {
  url: string;
  kind: 'img' | 'video' | 'iframe';
  y: number | null;
  ct?: string;
  section?: string;
}

function assetKeyString(k: AssetKey): string {
  return `${k[0]}\u0000${k[1]}\u0000${k[2].map(([a, b]) => `${a}=${b}`).join('&')}`;
}

function rank(c: Candidate): [number, number] {
  let w = 0;
  try {
    const q = new URL(c.url).searchParams;
    for (const key of ['w', 'width']) {
      const v = q.get(key);
      if (v !== null && /^\d+$/.test(v)) {
        w = parseInt(v, 10);
        break;
      }
    }
  } catch {
    w = 0;
  }
  return [w, c.y !== null ? 1 : 0];
}

function rankGt(a: [number, number], b: [number, number]): boolean {
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

// extract_assets.py's dedupe_candidates() (lines 675-691): one candidate
// per asset (by kind + asset_key), keeping the largest variant (by its
// w/width query param) and preferring one found on the page (has a
// position) over a network-only one on a tie.
export function dedupeCandidates(cands: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const c of cands) {
    const key = `${c.kind}\u0000${assetKeyString(assetKey(c.url))}`;
    const old = best.get(key);
    let keep: Candidate;
    let drop: Candidate | null;
    if (old === undefined || rankGt(rank(c), rank(old))) {
      keep = c;
      drop = old ?? null;
    } else {
      keep = old;
      drop = c;
    }
    if (drop !== null && keep.y === null) {
      keep.y = drop.y;
    }
    best.set(key, keep);
  }
  return Array.from(best.values());
}

// extract_assets.py's original_name() (line 510-511).
export function originalName(url: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const name = path.split('/').filter(Boolean).pop();
    return (name || 'file').slice(0, 120);
  } catch {
    return 'file';
  }
}

// extract_assets.py's humans() (line 528-529).
export function humanBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

// Bit-distance between two 64-bit perceptual hashes — the comparison
// extract_assets.py does with `h - oh` on imagehash.ImageHash objects
// (lines 1653, 1391), applied here to phash.ts's dHash bigints instead.
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export interface Dimensions {
  width: number | null;
  height: number | null;
}

// extract_assets.py's _similar_shape() (lines 1704-1712): a phash match
// counts as a true near-duplicate for the "images" category only if the
// two items also have close to the same aspect ratio (within 5%) —
// guards against two differently-cropped/shaped images that happen to
// hash close. Always true for other categories, matching the source.
export function similarShape(a: Dimensions, b: Dimensions, cat: 'images' | 'videos_gifs'): boolean {
  if (cat !== 'images') return true;
  if (!a.width || !a.height || !b.width || !b.height) return false;
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / Math.max(ra, rb) < 0.05;
}
