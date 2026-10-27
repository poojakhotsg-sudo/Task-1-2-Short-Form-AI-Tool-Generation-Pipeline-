// Pure, Playwright-free piece of grabber.py's record_missing_shot_clips()
// path (PIPE-05's not-ported fallback): picking which on-page heading a
// shot's "visual_needed" text is talking about, so the recording session
// knows where to scroll to. Ported from grabber.py's match_heading()/
// _words()/_common_run() (lines 494-538), same split used for every other
// "pure decision + real browser" pairing in this project.

export interface PageHeading {
  text: string;
  tag: string;
  hy: number;
  y: number;
  h: number;
}

// Every visible heading with the block it heads (nearest ancestor at
// least 300px tall), page-y. Evaluated in the browser; HEADINGS_JS's
// shape here is exactly grabber.py's (lines 474-491).
export const HEADINGS_JS = `() => {
  const out = [];
  document.querySelectorAll('h1, h2, h3, h4, h5, [role="heading"]').forEach(h => {
    const r = h.getBoundingClientRect(), st = getComputedStyle(h);
    if (r.width === 0 || r.height === 0 || st.display === 'none' || st.visibility === 'hidden') return;
    const text = (h.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!text || text.length > 160) return;
    let el = h;
    while (el.parentElement && el.parentElement !== document.body && el.getBoundingClientRect().height < 300)
      el = el.parentElement;
    const b = el.getBoundingClientRect();
    out.push({text, tag: h.tagName.toLowerCase(), hy: Math.round(r.top + scrollY),
              y: Math.round(b.top + scrollY), h: Math.round(Math.min(b.height, innerHeight * 1.5))});
  });
  return out;
}`;

function words(text: string): string[] {
  return (text.toLowerCase().replace(/'/g, '').match(/[a-z0-9]+/g) || []);
}

// Length of the longest run of consecutive words shared by word lists a and b.
function commonRun(a: string[], b: string[]): number {
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (const x of a) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (x === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        best = Math.max(best, cur[j]);
      }
    }
    prev = cur;
  }
  return best;
}

export interface MatchHeadingResult {
  heading: PageHeading | null;
  wordsMatched: number;
  reason: string | null;
}

// Pick the heading named in a shot's "visual_needed" text. A quoted
// phrase wins if a heading contains it; otherwise the heading sharing
// the longest run of consecutive words. Needs 3+ words in a row, or the
// whole heading if it is shorter.
export function matchHeading(visual: string, headings: PageHeading[]): MatchHeadingResult {
  if (headings.length === 0) {
    return { heading: null, wordsMatched: 0, reason: 'no headings found on the page' };
  }

  const vw = words(visual);

  const phraseRe = /['"‘“]([^'"’”]{6,})['"’”]/g;
  let phraseMatch: RegExpExecArray | null;
  while ((phraseMatch = phraseRe.exec(visual)) !== null) {
    const pw = words(phraseMatch[1]).join(' ');
    if (!pw) continue;
    for (const hd of headings) {
      if (words(hd.text).join(' ').includes(pw)) {
        return { heading: hd, wordsMatched: pw.split(' ').length, reason: null };
      }
    }
  }

  let best: { key: [number, number, number]; heading: PageHeading } | null = null;
  let bestRun = 0;
  for (const hd of headings) {
    const hw = words(hd.text);
    const run = commonRun(vw, hw);
    if (run >= 3 || (run >= 2 && run === hw.length)) {
      const key: [number, number, number] = [run, run / Math.max(hw.length, 1), -hd.hy];
      if (
        best === null ||
        key[0] > best.key[0] ||
        (key[0] === best.key[0] && key[1] > best.key[1]) ||
        (key[0] === best.key[0] && key[1] === best.key[1] && key[2] > best.key[2])
      ) {
        best = { key, heading: hd };
        bestRun = run;
      }
    }
  }

  if (best) {
    return { heading: best.heading, wordsMatched: bestRun, reason: null };
  }
  return { heading: null, wordsMatched: 0, reason: 'no heading on the page shares 3+ consecutive words with it' };
}
