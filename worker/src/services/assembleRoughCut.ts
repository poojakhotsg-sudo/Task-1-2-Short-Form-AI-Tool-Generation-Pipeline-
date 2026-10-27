import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { downloadObject, uploadObject } from '../lib/storage.js';
import { probeVideo, runFfmpeg } from '../lib/ffmpeg.js';

// PIPE-09, ported from pipeline/assembler.py's assemble()/trim_clip()/
// placeholder()/render_summary() (the whole file — it's short).
//
// A real bug this did NOT carry forward: the source hard-codes
// FONT = Path("C:/Windows/Fonts/arial.ttf") for placeholder-card text.
// AUDIT.md (Phase 1) already flagged this as a bug, not a stale-but-
// working assumption — the worker deploys on Linux (Section 6/PLAT-05's
// Dockerfile), where that path never exists. The source's OWN fallback
// ("if FONT.exists(): ... else: plain black, no text") is preserved
// exactly — only the font *search* is made portable: a small list of
// common Linux font paths, overridable via
// ASSEMBLE_PLACEHOLDER_FONT_PATH, falling back to a textless black card
// (not an error) if none are found. Same graceful degradation the
// source already had, just pointed at paths that can actually exist.
//
// Data-model difference from the source, not a gap: assembler.py reads
// shot durations from BOTH manifest.json's shots[] and shot_list.json
// as a fallback-supplement, because those were two separately-written
// files from two different pipeline stages that could drift apart. In
// this port, match.ts already merges shot_list.json's durations into
// each shot when it writes match_result.json (durationSeconds — see
// that file's own comment on why this field exists at all), so there's
// one source of truth here, not two to reconcile.
//
// Not ported: assembler.py's "needs_manual" classification bucket —
// that's PIPE-07 trial-recording's own fallback state, which isn't
// built yet. match.ts's MatchedShot only has 'ok' | 'missing' |
// 'needs_trial', so the summary groups by those instead.

const W = 1080;
const H = 1920;
const FPS = 30;
const DEFAULT_PLACEHOLDER_S = 3.0;
const ENCODE_ARGS = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an'];

const LINUX_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
];

function resolvePlaceholderFont(): string | null {
  const override = process.env.ASSEMBLE_PLACEHOLDER_FONT_PATH;
  if (override && existsSync(override)) return override;
  for (const candidate of LINUX_FONT_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Minimal local copy of match.ts's output shape — no shared package
// between the two projects yet (same note as elsewhere in this worker).
export interface MatchedShot {
  shot: number;
  label: string;
  scriptLine: string;
  source: 'website' | 'trial';
  file: string | null;
  status: 'ok' | 'missing' | 'needs_trial';
  durationSeconds: number;
}

export interface MatchResult {
  shots: MatchedShot[];
}

export function classifyShot(shot: MatchedShot): { kind: 'covered' | 'missing' | 'needs_trial'; hasClip: boolean } {
  if (shot.status === 'needs_trial') return { kind: 'needs_trial', hasClip: false };
  const hasClip = Boolean(shot.file);
  return { kind: hasClip ? 'covered' : 'missing', hasClip };
}

// assembler.py's trim_clip(): re-encode `want` seconds of src to
// 1080x1920@30 (letterboxed, not cropped — force_original_aspect_ratio=
// decrease + pad centers the source instead of stretching/cropping it).
// Trial clips keep their END ("the result"), not their start.
export async function trimClip(
  srcPath: string,
  outPath: string,
  want: number | null,
  fromEnd: boolean
): Promise<{ take: number; length: number }> {
  const { seconds: length } = await probeVideo(srcPath);
  const take = want ? Math.min(want, length) : length;
  const start = fromEnd ? Math.max(0, length - take) : 0;
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  await runFfmpeg(['-ss', start.toFixed(2), '-i', srcPath, '-t', take.toFixed(2), '-vf', vf, ...ENCODE_ARGS, outPath]);
  return { take, length };
}

// assembler.py's placeholder(): a black card for `seconds`, labeled with
// the shot number — falls back to no text (not an error) if no usable
// font is found, matching the source's own `if FONT.exists()` guard.
export async function placeholderClip(outPath: string, seconds: number, label: string): Promise<void> {
  const font = resolvePlaceholderFont();
  let vf = 'null';
  if (font) {
    const text = label.replace(/\\/g, '').replace(/:/g, '\\:').replace(/'/g, '');
    const fontEscaped = font.replace(/\\/g, '/').replace(/:/g, '\\:');
    vf = `drawtext=fontfile='${fontEscaped}':text='${text}':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2`;
  }
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}:d=${seconds.toFixed(2)}`,
    '-vf', vf,
    ...ENCODE_ARGS,
    outPath,
  ]);
}

interface SummaryRow {
  shot: MatchedShot;
  kind: 'covered' | 'missing' | 'needs_trial';
  want: number | null;
  start: number | null;
  used: string;
  note: string;
}

function formatTimestamp(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

// assembler.py's render_summary(), ported line-for-line (table columns,
// section headings, QA-fail-in-cut callout).
export function renderSummary(toolName: string, rows: SummaryRow[], total: number, hasCut: boolean): string {
  const line = (r: SummaryRow): string => {
    const at = r.start !== null ? formatTimestamp(r.start) : '-';
    const want = r.want ? `${r.want}s` : '-';
    return `| ${r.shot.shot} | ${at} | ${want} | ${r.used} | ${r.shot.source || '-'} | ${(r.shot.scriptLine || '').replace(/\|/g, '/')} | ${r.note} |`;
  };

  const head = '| Shot | At | Target | In cut | Source | Visual | Note |\n|---|---|---|---|---|---|---|';
  const groups = {
    covered: rows.filter((r) => r.kind === 'covered'),
    missing: rows.filter((r) => r.kind === 'missing'),
    needs_trial: rows.filter((r) => r.kind === 'needs_trial'),
  };

  const out: string[] = [
    `# ${toolName} rough cut`,
    '',
    hasCut ? `- Rough cut: \`rough_cut.mp4\` (${formatTimestamp(total)}, ${W}x${H})` : '- Rough cut: not made (no shots to cut)',
    `- Shots: ${rows.length} total, ${groups.covered.length} covered, ${groups.missing.length} missing, ${groups.needs_trial.length} needs trial`,
    '',
    `## Covered (${groups.covered.length})`,
    '',
  ];
  out.push(...(groups.covered.length > 0 ? [head, ...groups.covered.map(line)] : ['None.']));

  out.push('', `## Missing (${groups.missing.length})`, '');
  out.push(...(groups.missing.length > 0 ? [head, ...groups.missing.map(line)] : ['None.']));

  out.push('', `## Needs trial (${groups.needs_trial.length})`, '');
  out.push(...(groups.needs_trial.length > 0 ? [head, ...groups.needs_trial.map(line)] : ['None.']));

  return out.join('\n') + '\n';
}

export interface AssembleResult {
  roughCutUploaded: boolean;
  shotsTotal: number;
  shotsCovered: number;
  shotsMissing: number;
  shotsNeedTrial: number;
}

export async function assembleRoughCut(
  toolName: string,
  matchStoragePrefix: string,
  storagePrefix: string,
  placeholders = true
): Promise<AssembleResult> {
  const matchResultBytes = await downloadObject(`${matchStoragePrefix}match_result.json`);
  if (!matchResultBytes) {
    throw new Error(`match_result.json not found at ${matchStoragePrefix} (match stage must run first)`);
  }
  const matchResult = JSON.parse(matchResultBytes.toString('utf-8')) as MatchResult;
  const shots = [...matchResult.shots].sort((a, b) => a.shot - b.shot);

  const tempDir = await mkdtemp(join(tmpdir(), 'assemble-'));
  const rows: SummaryRow[] = [];
  const parts: string[] = [];
  let t = 0;

  try {
    for (const shot of shots) {
      const { kind, hasClip } = classifyShot(shot);
      const want = shot.durationSeconds || null;
      const segPath = join(tempDir, `seg${String(shot.shot).padStart(3, '0')}.mp4`);
      const row: SummaryRow = { shot, kind, want, start: t, used: '', note: '' };

      if (hasClip) {
        const clipBytes = await downloadObject(shot.file!);
        if (!clipBytes) {
          rows.push({ ...row, used: 'left out', start: null, note: `clip missing from storage (${shot.file})` });
          continue;
        }
        const srcPath = join(tempDir, `src${String(shot.shot).padStart(3, '0')}.mp4`);
        await writeFile(srcPath, clipBytes);

        let take: number, length: number;
        try {
          ({ take, length } = await trimClip(srcPath, segPath, want, shot.source === 'trial'));
        } catch (err) {
          rows.push({
            ...row,
            used: 'left out',
            start: null,
            note: `ffmpeg trim failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }

        row.used = `clip (${take.toFixed(1)}s)`;
        if (!want) row.note = `no duration_seconds, used full ${length.toFixed(1)}s clip`;
        else if (length < want) row.note = `clip only ${length.toFixed(1)}s, wanted ${want}s`;

        parts.push(segPath);
        t += take;
        rows.push(row);
      } else if (placeholders) {
        const take = want || DEFAULT_PLACEHOLDER_S;
        try {
          await placeholderClip(segPath, take, `SHOT ${shot.shot} MISSING`);
        } catch (err) {
          rows.push({
            ...row,
            used: 'left out',
            start: null,
            note: `placeholder generation failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
        row.used = `placeholder (${take.toFixed(1)}s)`;
        parts.push(segPath);
        t += take;
        rows.push(row);
      } else {
        rows.push({ ...row, used: 'left out', start: null });
      }
    }

    let roughCutUploaded = false;
    if (parts.length > 0) {
      const concatPath = join(tempDir, 'concat.txt');
      const concatBody = parts.map((p) => `file '${p.replace(/\\/g, '/')}'\n`).join('');
      await writeFile(concatPath, concatBody, 'utf-8');

      const outPath = join(tempDir, 'rough_cut.mp4');
      await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', '-movflags', '+faststart', outPath]);

      await uploadObject({
        key: `${storagePrefix}rough_cut.mp4`,
        body: await readFile(outPath),
        contentType: 'video/mp4',
      });
      roughCutUploaded = true;
    }

    const summary = renderSummary(toolName, rows, t, roughCutUploaded);
    await uploadObject({ key: `${storagePrefix}summary.md`, body: summary, contentType: 'text/markdown' });

    return {
      roughCutUploaded,
      shotsTotal: rows.length,
      shotsCovered: rows.filter((r) => r.kind === 'covered').length,
      shotsMissing: rows.filter((r) => r.kind === 'missing').length,
      shotsNeedTrial: rows.filter((r) => r.kind === 'needs_trial').length,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
