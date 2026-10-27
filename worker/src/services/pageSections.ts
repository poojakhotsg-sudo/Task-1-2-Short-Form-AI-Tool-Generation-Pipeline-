// Pure, Playwright-free pieces of grabber.py's section-clip recording
// (PIPE-02), ported faithfully so they're directly unit-testable without
// a real browser — same split used for web-next's match/scriptParser.ts.

export interface PageBlock {
  y: number;
  h: number;
  text: string;
  title: string;
  video: boolean;
  img?: boolean;
}

// Python's round() uses round-half-to-even (banker's rounding) for the
// .5 case; JS's Math.round() always rounds half up. Confirmed directly
// in Python (round(4.5) == 4, not 5) rather than assumed — this matters
// here because pick_sections' index formula hits exactly .5 for common
// inputs (e.g. 10 sections, maxN=3 picks index 4.5), and rounding it the
// JS-default way would pick a different section than the source does.
function roundHalfToEven(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

// grabber.py's pick_sections(): one per distinct heading/title, top to
// bottom, spread out by even index sampling if there are more than
// max_n. The index formula (`round(i * (len-1) / (max_n-1))`) is ported
// exactly, not approximated — it's what decides which middle sections
// get dropped when a page has many more sections than MAX_SECTIONS.
export function pickSections(blocks: PageBlock[], maxN: number): PageBlock[] {
  const seen = new Set<string>();
  const picks: PageBlock[] = [];

  for (const b of blocks) {
    const key = (b.title || b.text.slice(0, 60)).toLowerCase().replace(/\W+/g, ' ').trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      picks.push(b);
    }
  }

  if (picks.length <= maxN) return picks;
  if (maxN <= 1) return picks.slice(0, maxN);

  const indexSet = new Set<number>();
  for (let i = 0; i < maxN; i++) {
    indexSet.add(roundHalfToEven((i * (picks.length - 1)) / (maxN - 1)));
  }
  const indices = Array.from(indexSet).sort((a, b) => a - b);
  return indices.map((i) => picks[i]);
}

// grabber.py's slugify() (used by both library_name() and clip_name()).
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

// grabber.py's library_name(n, title) — names a recorded section clip.
export function libraryName(n: number, title: string): string {
  const name = slugify(title).slice(0, 32).replace(/^-+|-+$/g, '') || 'section';
  return `clip${String(n).padStart(2, '0')}_${name}.mp4`;
}

// grabber.py's clip_name(shot) — names a recorded per-shot clip. Same
// deterministic naming web-next's match/scriptParser.ts clipName() uses
// to check for an already-recorded clip (Rule 1b); this is what
// record_missing_shot_clips writes under that exact name.
export function shotClipName(shotNumber: number, visualNeeded: string): string {
  const words = slugify(visualNeeded || '').split('-').filter(Boolean);
  let name = words.join('-').slice(0, 32).replace(/^-+|-+$/g, '');
  if (!name) name = 'clip';
  return `shot${String(shotNumber).padStart(2, '0')}_${name}.mp4`;
}
