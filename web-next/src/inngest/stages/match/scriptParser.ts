// Faithful TypeScript port of pipeline/matcher.py's parse_script() and
// build_shots() (lines 47-134 of the source file). These are pure string
// functions with no I/O — ported exactly, including the regex patterns
// and the label-assignment branching, rather than reinterpreted.
//
// NOT ported from matcher.py in this pass (see match.ts's own comment
// for the full reasoning): Rule 3's keyword-overlap-against-"library"
// matching (no "library" data source exists yet — PIPE-02's section
// clips with heading+text metadata aren't produced by capture_site yet)
// and record_missing_shot_clips (needs worker-side Playwright recording,
// contradicting Phase 3's original assumption that `match` needs no
// worker call — flagged as a correction, not silently dropped).

const HEADER_RE = /^\s*\[\s*(\d+(?:\.\d+)?)\s*s?\s*[-–]\s*(\d+(?:\.\d+)?)\s*s?\s*\]\s*(.*)$/;
const STEP_RE = /^(?:feature|step|part|point|f|shot|beat)\s*#?\s*(\d+)$/i;
const KEEP_LABELS = new Set(['HOOK', 'PROOF', 'CTA', 'INTRO', 'OUTRO', 'DEMO', 'RESULT']);
const TRIAL_HINT =
  /\b(proof|my own|our own|own test|for me|i (built|made|tried|tested|asked)|here'?s (the|what) it (built|made)|watch (it|this) (build|make))\b/i;
const SOURCE_MARKER_RE = /\((website|trial)\)/i;

export interface ScriptSegment {
  label: string;
  title: string;
  start: number;
  end: number;
  scriptLine: string;
  source: 'website' | 'trial';
  sourceGiven: boolean;
}

interface RawSegment {
  head: string;
  title: string;
  start: number;
  end: number;
  lines: string[];
  source: 'website' | 'trial' | null;
}

function isAllUpper(s: string): boolean {
  return s.length > 0 && s === s.toUpperCase() && s !== s.toLowerCase();
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

export function parseScript(text: string): ScriptSegment[] {
  const raw: RawSegment[] = [];
  let cur: RawSegment | null = null;

  for (const line of text.split(/\r?\n/)) {
    const m = HEADER_RE.exec(line);
    if (m) {
      const start = parseFloat(m[1]);
      const end = parseFloat(m[2]);
      let rest = m[3].trim();
      const sourceMatch = SOURCE_MARKER_RE.exec(rest);
      rest = rest.replace(SOURCE_MARKER_RE, '').trim();
      const dashIdx = rest.indexOf(' - ');
      const head = (dashIdx === -1 ? rest : rest.slice(0, dashIdx)).trim();
      const title = (dashIdx === -1 ? '' : rest.slice(dashIdx + 3)).trim();
      cur = {
        head,
        title: isAllUpper(title) ? capitalize(title) : title,
        start,
        end,
        lines: [],
        source: sourceMatch ? (sourceMatch[1].toLowerCase() as 'website' | 'trial') : null,
      };
      raw.push(cur);
    } else if (cur !== null && line.trim()) {
      cur.lines.push(line.trim());
    }
  }

  const out: ScriptSegment[] = [];
  let step = 0;

  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const headUpper = s.head.toUpperCase();
    const line = s.lines.join(' ');
    const stepMatch = STEP_RE.exec(s.head);
    let label: string | null;
    let title = s.title;

    if (KEEP_LABELS.has(headUpper)) {
      label = headUpper;
    } else if (stepMatch && !headUpper.startsWith('SHOT')) {
      label = `STEP ${parseInt(stepMatch[1], 10)}`;
    } else {
      // "SHOT 3" or a free-form header: name it by position/role.
      if (i === 0) {
        label = 'HOOK';
      } else if (i === raw.length - 1 && raw.length > 1) {
        label = 'CTA';
      } else if (s.source === 'trial' || TRIAL_HINT.test(line)) {
        label = 'PROOF';
      } else {
        label = null;
      }
      if (!title && s.head && !STEP_RE.test(s.head)) {
        title = isAllUpper(s.head) ? capitalize(s.head) : s.head;
      }
    }

    if (label === null) {
      step += 1;
      label = `STEP ${step}`;
    } else if (label.startsWith('STEP')) {
      step = parseInt(label.split(' ')[1], 10);
    }

    const source: 'website' | 'trial' =
      s.source ?? (label === 'PROOF' || TRIAL_HINT.test(line) ? 'trial' : 'website');

    out.push({
      label,
      title,
      start: s.start,
      end: s.end,
      scriptLine: line,
      source,
      sourceGiven: s.source !== null,
    });
  }

  return out;
}

// PIPE-04's "asset-first" shot_list.json format: each entry already names
// its own visual (visual_needed), optional pre-resolved clip_file, and
// duration — matcher.py's build_shots() uses this directly when present,
// bypassing segments/script.txt entirely. ScriptGenShot mirrors that
// shape; AlignedShotExtra is the narrower shape used only in the
// segment-alignment fallback branch below.
export interface ScriptGenShot {
  shot?: number;
  visual_needed?: string;
  time?: string;
  duration_seconds?: number;
  script_line?: string;
  source?: 'website' | 'trial';
  clip_file?: string | null;
  trial_steps?: string[];
}

export interface Shot {
  shot: number;
  label: string;
  title: string;
  start: number;
  end: number;
  time: string;
  durationSeconds: number;
  scriptLine: string;
  source: 'website' | 'trial';
  clipFile: string | null;
  visualNeeded: string;
  trialSteps: string[];
  file: string | null;
  matchScore: number;
}

function fmtSeconds(sec: number): string {
  // Mirrors Python's `f"{sec:g}"` — shortest representation, no forced
  // decimal places (5 stays "5", 5.5 stays "5.5").
  return Number(sec.toPrecision(6)).toString();
}

export function buildShots(segments: ScriptSegment[], shotList?: ScriptGenShot[] | null): Shot[] {
  if (shotList && Array.isArray(shotList) && shotList.length > 0 && shotList.every((s) => typeof s === 'object')) {
    return shotList.map((s, i) => {
      const shotNo = s.shot ?? i + 1;
      const duration = s.duration_seconds ?? 5.0;
      return {
        shot: shotNo,
        label: `SHOT ${shotNo}`,
        title: s.visual_needed ?? '',
        start: 0.0,
        end: duration,
        time: s.time ?? `${fmtSeconds(duration)}s`,
        durationSeconds: duration,
        scriptLine: s.script_line ?? '',
        source: s.source ?? 'website',
        clipFile: s.clip_file ?? null,
        visualNeeded: s.visual_needed ?? '',
        trialSteps: s.trial_steps ?? [],
        file: null,
        matchScore: 0.0,
      };
    });
  }

  const aligned = shotList && shotList.length === segments.length ? shotList : undefined;

  return segments.map((seg, i) => {
    const extra = aligned?.[i];
    let source = seg.source;
    if (!seg.sourceGiven && (extra?.source === 'website' || extra?.source === 'trial')) {
      source = extra.source;
    }
    return {
      shot: i + 1,
      label: seg.label,
      title: seg.title,
      start: seg.start,
      end: seg.end,
      time: `${fmtSeconds(seg.start)}-${fmtSeconds(seg.end)}s`,
      durationSeconds: Math.round((seg.end - seg.start) * 100) / 100,
      scriptLine: seg.scriptLine,
      source,
      clipFile: extra?.clip_file ?? null,
      visualNeeded: extra?.visual_needed || seg.title || '',
      trialSteps: extra?.trial_steps ?? [],
      file: null,
      matchScore: 0.0,
    };
  });
}

// matcher.py's clip_name(shot), via grabber.py's slugify(). Pure and
// deterministic — used by match.ts's Rule 1b (a per-shot clip already
// recorded under this exact name is reused directly, no scoring needed).
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function clipName(shot: Shot): string {
  const words = slugify(shot.visualNeeded || '').split('-').filter(Boolean);
  let name = words.join('-').slice(0, 32).replace(/^-+|-+$/g, '');
  if (!name) name = 'clip';
  return `shot${String(shot.shot).padStart(2, '0')}_${name}.mp4`;
}
