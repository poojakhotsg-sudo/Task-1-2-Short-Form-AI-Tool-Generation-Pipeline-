import { downloadObjectText, objectExists, uploadObjectJson } from '@/lib/objectStorage';
import { callWorkerTask } from '@/lib/workerClient';
import type { StageExecutor } from './types';
import { stageStoragePrefix } from './types';
import { parseScript, buildShots, clipName, type ScriptGenShot } from './match/scriptParser';
import { scoreCatalogAgainstLine } from './match/clipScoring';
import type { ClipCatalog, MatchedShot, MatchResult } from './match/types';

// PIPE-05, ported from pipeline/matcher.py's match() (lines 188-331).
//
// NOT ported in this pass — flagged, not silently dropped:
//
// 1. Rule 3 (matcher.py lines 287-305): keyword-overlap matching against
//    manifest.json's "library" entries (grab-stage section recordings
//    with heading+text metadata). No such data source exists yet —
//    capture_site (worker) doesn't record section clips or write that
//    metadata today. Wiring this rule against clip_catalog.json instead
//    (the only thing that does exist) would just duplicate Rule 2
//    against the same data under a different name, which isn't a
//    faithful port of a *different* rule — so it's left out rather than
//    faked.
//
// record_missing_shot_clips (grabber.py line 1471) IS now ported — see
// the worker's own `recordMissingShotClips.ts` and
// `docs/record-missing-shot-clips.md` for what it does and the one real
// behavior correction it makes (matcher.py's shot dicts never carry the
// "status": "pending" field record_missing_shot_clips' heading-matching
// requires, so every call from match() in the source silently finds 0
// headings and degrades to pure "mark missing" — a latent bug, not a
// deliberate skip, fixed here so the capability the user asked to port
// actually does something).
//
// Continuity note, same shape as grab/describe: this stage requires
// shot_list.json, which the `script` stage writes — and script.ts is
// still a stub that always throws. Per the dependency graph
// (stageGraph.ts: match requires [grab, script]), the orchestrator will
// never actually reach this code until script is real. Built ahead of
// that anyway, same as describe_clips was built ahead of grab recording
// real clips.
export const runMatchStage: StageExecutor = async (ctx) => {
  const scriptPrefix = stageStoragePrefix(ctx, 'script');
  const grabPrefix = stageStoragePrefix(ctx, 'grab');
  const describePrefix = stageStoragePrefix(ctx, 'describe');
  const matchPrefix = stageStoragePrefix(ctx, 'match');

  const shotListText = await downloadObjectText(`${scriptPrefix}shot_list.json`);
  if (!shotListText) {
    // Matches matcher.py's explicit RuntimeError when shot_list.json is
    // missing — match cannot do its job at all without it, unlike
    // grab/describe where "nothing to do yet" is a valid, honest empty
    // result.
    throw new Error(`shot_list.json not found at ${scriptPrefix} (script stage must run first)`);
  }

  let shotList: ScriptGenShot[];
  try {
    const parsed = JSON.parse(shotListText);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    shotList = parsed as ScriptGenShot[];
  } catch (err) {
    throw new Error(
      `could not parse shot_list.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const scriptText = await downloadObjectText(`${scriptPrefix}script.txt`);
  const segments = scriptText ? parseScript(scriptText) : [];
  const shots = buildShots(segments, shotList);

  const catalogText = await downloadObjectText(`${describePrefix}clip_catalog.json`);
  let catalog: ClipCatalog = {};
  if (catalogText) {
    try {
      catalog = JSON.parse(catalogText) as ClipCatalog;
    } catch {
      catalog = {}; // matches matcher.py's bare except around a corrupt catalog read
    }
  }
  const catalogEntries = Object.entries(catalog).map(([file, entry]) => ({ file, ...entry }));

  const usedFiles = new Set<string>();
  const matched: MatchedShot[] = [];

  for (const shot of shots) {
    if (shot.source === 'trial') {
      matched.push({
        shot: shot.shot,
        label: shot.label,
        scriptLine: shot.scriptLine,
        source: shot.source,
        durationSeconds: shot.durationSeconds,
        file: null,
        status: 'needs_trial',
        matchScore: 0,
        matchType: null,
        error: 'trial shot: needs recording inside tool (manual trial-recording fallback)',
      });
      continue;
    }

    // Rule 1: the script stage already named a specific clip for this shot.
    if (shot.clipFile && (await objectExists(shot.clipFile))) {
      usedFiles.add(shot.clipFile);
      matched.push({
        shot: shot.shot,
        label: shot.label,
        scriptLine: shot.scriptLine,
        source: shot.source,
        durationSeconds: shot.durationSeconds,
        file: shot.clipFile,
        status: 'ok',
        matchScore: 1.0,
        matchType: 'script_specified',
      });
      continue;
    }

    // Rule 1b: a per-shot clip was already recorded under this shot's
    // deterministic name (clipName()) — reuse it directly.
    const perShotKey = `${grabPrefix}clips/${clipName(shot)}`;
    if (shot.visualNeeded && (await objectExists(perShotKey))) {
      usedFiles.add(perShotKey);
      matched.push({
        shot: shot.shot,
        label: shot.label,
        scriptLine: shot.scriptLine,
        source: shot.source,
        durationSeconds: shot.durationSeconds,
        file: perShotKey,
        status: 'ok',
        matchScore: 1.0,
        matchType: 'per_shot_clip',
      });
      continue;
    }

    // Rule 2: score the clip catalog against this shot's script line.
    const MIN_CONFIDENCE = 0.5;
    const scores = await scoreCatalogAgainstLine(shot.scriptLine, catalogEntries);
    const available = Object.entries(scores)
      .filter(([file, score]) => score >= MIN_CONFIDENCE && !usedFiles.has(file) && file in catalog)
      .sort((a, b) => b[1] - a[1]);

    if (available.length > 0) {
      const [file, score] = available[0];
      usedFiles.add(file);
      matched.push({
        shot: shot.shot,
        label: shot.label,
        scriptLine: shot.scriptLine,
        source: shot.source,
        durationSeconds: shot.durationSeconds,
        file,
        status: 'ok',
        matchScore: Math.round(score * 100) / 100,
        matchType: 'vision_score',
      });
      continue;
    }

    // Nothing matched this shot yet — tentatively missing. The
    // record_missing_shot_clips fallback below gets one more try at it
    // before this is final.
    matched.push({
      shot: shot.shot,
      label: shot.label,
      scriptLine: shot.scriptLine,
      source: shot.source,
      durationSeconds: shot.durationSeconds,
      file: null,
      status: 'missing',
      matchScore: 0,
      matchType: null,
      error: `insufficient website assets for visual: '${shot.visualNeeded || shot.scriptLine}'`,
    });
  }

  // record_missing_shot_clips fallback: one more mobile-recording pass,
  // aimed at the heading each still-unmatched shot's visual_needed names.
  const pendingForRecording = matched.filter((s) => s.status === 'missing' && s.source === 'website');
  if (pendingForRecording.length > 0) {
    try {
      const shotsByNumber = new Map(shots.map((s) => [s.shot, s]));
      const workerResult = await callWorkerTask('record_missing_shot_clips', {
        jobId: ctx.jobId,
        toolSlug: ctx.toolSlug,
        url: ctx.url,
        storagePrefix: grabPrefix,
        headed: ctx.headed ?? false,
        shots: pendingForRecording.map((s) => ({
          shot: s.shot,
          visualNeeded: shotsByNumber.get(s.shot)?.visualNeeded ?? '',
          scriptLine: s.scriptLine,
          durationSeconds: s.durationSeconds,
        })),
      });

      if (workerResult.status === 'ok') {
        const recordedByShot = new Map(
          ((workerResult.data?.shots as { shot: number; file: string | null; error: string | null }[]) ?? []).map(
            (r) => [r.shot, r]
          )
        );
        for (const m of matched) {
          const recorded = recordedByShot.get(m.shot);
          if (!recorded) continue;
          if (recorded.file) {
            usedFiles.add(recorded.file);
            m.file = recorded.file;
            m.status = 'ok';
            m.matchScore = 1.0;
            m.matchType = 'mobile_recording';
            delete m.error;
          } else if (recorded.error) {
            m.error = recorded.error;
          }
        }
      }
      // A worker-level error (status: 'error') is non-fatal here, matching
      // matcher.py's try/except around this whole call — the pending
      // shots just stay 'missing' with their original error.
    } catch {
      // Same non-fatal handling for a thrown error (e.g. WORKER_BASE_URL
      // not configured) — matcher.py's record_missing_shot_clips() call
      // is itself wrapped in a bare try/except for exactly this reason.
    }
  }

  const result: MatchResult = {
    shots: matched,
    matchedCount: matched.filter((s) => s.file).length,
    clipsAvailable: catalogEntries.length,
  };

  await uploadObjectJson(`${matchPrefix}match_result.json`, result);

  return {
    message: `Matched ${result.matchedCount}/${matched.length} shots (${result.clipsAvailable} catalog clips available)`,
    data: { matchedCount: result.matchedCount, totalShots: matched.length, clipsAvailable: result.clipsAvailable },
  };
};
