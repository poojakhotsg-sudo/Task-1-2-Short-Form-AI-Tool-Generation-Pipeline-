# Rough-cut assembly (PIPE-09)

`/tasks/assemble_rough_cut`'s real implementation, ported from
`pipeline/assembler.py` in full (the file is short — `assemble()`,
`trim_clip()`, `placeholder()`, `render_summary()`, all ported).

## What this does

For each shot in `match_result.json` (the `match` stage's output,
sorted by shot number):

1. **Covered** (has a `file`): download the clip, re-encode it to
   1080×1920 with letterboxing (`scale=...:force_original_aspect_ratio=
   decrease,pad=...,setsar=1` — centers the source instead of stretching
   or cropping it), trimmed to the shot's `durationSeconds`. A
   `source: 'trial'` shot keeps its **end**, not its start (the actual
   result, not the setup) — though see the continuity note below.
2. **Missing** (no file) **and placeholders enabled** (the default): a
   black placeholder card labeled `SHOT <n> MISSING`, for the shot's
   target duration (or 3s if none is known).
3. **Missing with placeholders disabled**: left out of the cut
   entirely — the rough cut just runs shorter.
4. **`needs_trial`**: treated the same as "missing" for cutting
   purposes (no clip exists to trim) — see "not ported" below for why
   this bucket exists at all.

All the parts that got a clip or a placeholder are concatenated (ffmpeg
concat demuxer, stream copy) into `rough_cut.mp4`. A `summary.md`
(Covered/Missing/Needs trial sections, one markdown table row per shot)
is written either way, even when nothing was cut.

## A real bug this did NOT carry forward

The source hard-codes `FONT = Path("C:/Windows/Fonts/arial.ttf")` for
placeholder-card text. `AUDIT.md`'s Phase 1 pass already flagged this as
a bug, not a stale-but-working assumption — this worker deploys on Linux
(Section 6 / PLAT-05's Dockerfile), where that path never exists. Fixed
by searching a short list of common Linux font paths instead
(`resolvePlaceholderFont()` in `assembleRoughCut.ts`), overridable via
`ASSEMBLE_PLACEHOLDER_FONT_PATH`. The source's own graceful fallback —
"if no font is found, render a plain black card with no text, don't
error" — is preserved exactly; only the search target changed.

Verified against real `ffmpeg` (not just read against its docs — this
environment happens to have `ffmpeg`/`ffprobe` on `PATH`,
`assembleRoughCut.ffmpeg.test.ts`): on this machine, none of the
candidate Linux font paths exist, so the test genuinely exercises the
textless fallback path end-to-end, not the `drawtext` branch.

## A data-model difference from the source — not a gap

`assembler.py`'s `load_durations()` reads shot durations from **both**
`manifest.json`'s `shots[]` and `shot_list.json` as a fallback-
supplement, because those were two separately-written files from two
different pipeline stages that could drift out of sync. In this port,
`match.ts` (`web-next`) already merges `shot_list.json`'s durations into
each shot before writing `match_result.json` — that field was actually
being **silently dropped** until this task's prerequisite fix (see
`match/types.ts`'s `MatchedShot.durationSeconds` comment). There is one
source of truth here, not two to reconcile, so this port doesn't
re-read `shot_list.json` independently.

## Not ported

- **The `needs_manual` classification bucket.** `assembler.py`'s
  `classify()` has a third status beyond covered/missing — a shot
  flagged `needs_manual` by the trial-recording stage. `match.ts`'s
  `MatchedShot.status` only has `'ok' | 'missing' | 'needs_trial'` (no
  `needs_manual`) because PIPE-07's manual-fallback flagging isn't built
  yet. The summary groups by `needs_trial` instead — same shape, honest
  about why the label differs.

## Test coverage

- `assembleRoughCut.pure.test.ts` — `classifyShot`/`renderSummary`
  against synthetic shot data (no ffmpeg, no storage): grouping counts,
  the "None." fallback for an empty group, pipe-character escaping in
  the markdown table, and the "rough cut made" vs. "not made" header
  lines.
- `assembleRoughCut.ffmpeg.test.ts` — `trimClip`/`placeholderClip`
  against **real** `ffmpeg`: a generated placeholder actually probes as
  1080×1920 at the requested duration; a deliberately wrong-aspect-ratio
  synthetic source gets correctly letterboxed and trimmed; `fromEnd`
  takes the tail, not the head; `want: null` uses the full source
  length. Skips cleanly if `ffmpeg` isn't on `PATH`.
- `assembleRoughCut.service.test.ts` — the orchestration layer
  (`assembleRoughCut()`) with storage and ffmpeg mocked: the
  missing-`match_result.json` error, per-shot branching (covered /
  missing-with-placeholder / missing-without-placeholder / needs_trial),
  and that `summary.md` is written even when nothing gets cut.
- `assembleRoughCut.route.test.ts` — the HTTP layer with the service
  mocked: request validation (including the `placeholders` default),
  the `roughCutKey`/`summaryKey` response shape, honest messaging when
  nothing was cut, and error-path status codes.
