# Automatic clip quality checks (PIPE-06)

`/tasks/run_qa`'s real implementation, ported from `pipeline/qa.py`'s
`check_clip()`/`frame_stats()`/`probe()` (the per-clip checking logic —
not `annotate()`'s broader manifest bookkeeping, see below).

## What this does

For every clip under `grabStoragePrefix/clips/`:

1. **Probe** (`lib/ffmpeg.ts`'s `probeVideo`): duration + resolution via
   `ffprobe`.
2. **Sample 12 frames** across the clip, each resized to 360px wide and
   converted to grayscale (`lib/ffmpeg.ts`'s `extractGrayscaleFrameRaw`,
   via `ffmpeg`'s rawvideo muxer — no container, just raw 8-bit pixel
   bytes).
3. For each sampled frame, compute **sharpness** (3×3 Laplacian
   variance) and whether it's **blank** (grayscale stddev < 8); between
   consecutive samples, compute **motion** (mean absolute pixel
   difference) — all in `qa/imageMetrics.ts`, pure functions over raw
   pixel buffers.
4. **Decide pass/fail** (`qa/checkClip.ts`'s `evaluateMetrics`, ported
   verbatim from `check_clip()`'s thresholds):
   - Length must be 3-15s.
   - Resolution must be exactly 1080×1920.
   - Median sharpness must be ≥ 500.
   - At most half the sampled frames may be "blank."
   - At most half the frame-pair motion values may be "static" (< 1.0).
5. Upload a `qa_report.json` (one row per clip: file, metrics, `ok`,
   `issues`) to `storagePrefix`.

## A real deviation from the source — flagged, not hidden

`qa.py` samples by **frame index**: it asks OpenCV for the clip's total
frame count, then takes 12 evenly-spaced *indices* via
`np.linspace(...).astype(int)`. This worker has no native video-decoding
binding (OpenCV or otherwise) — Section 6 leaves that choice open, and
none has been added — so getting an exact frame count and seeking to a
specific decoded frame isn't practical with the `ffmpeg` CLI alone.

`checkClip()` instead samples by **time**: 12 evenly-spaced timestamps
across the probed duration. This serves the same purpose (12 samples
spread across the clip) and feeds the same threshold comparisons, but
will not reproduce `qa.py`'s metrics bit-for-bit, and in principle could
land on a very slightly different set of frames near scene changes than
frame-index sampling would. For QA's actual job — pass/fail against
empirically calibrated cutoffs, not exact numeric reproduction — this is
a reasonable approximation. It's called out here and in `checkClip.ts`'s
own comments so it's a decision on record, not a silent gap.

A second, smaller deviation: the Laplacian convolution uses edge-clamped
borders, where OpenCV's default is `BORDER_REFLECT_101`. Also flagged in
`imageMetrics.ts`'s own comment — the two will not produce identical
sharpness values at image edges.

## Not ported in this pass

`qa.py`'s `annotate()`/`refresh_clip_map()` rewrite a tool's entire
`manifest.json` — per-shot `qa`/`qa_reasons` fields, a `clips` map
(shot number → file/status/reason), and a `needs_trial` list. That's
DB/job-state bookkeeping over *shot* assignments, which only exist once
`match.ts` has run for real — this worker's job is reporting facts about
clip *files*, not deciding what a tool's shots need next. If/when
`web-next`'s `qa.ts` stage needs that bookkeeping, it belongs there
(it already has the DB), reading this endpoint's `qa_report.json`, not
duplicated into the worker.

## Test coverage

- `imageMetrics.test.ts` — exact unit tests of `laplacianVariance`/
  `stddev`/`meanAbsDiff`/`median`/`mean` against synthetic pixel buffers
  with hand-computed expected values (no video, no ffmpeg).
- `checkClip.test.ts` — `evaluateMetrics`'s threshold logic, including
  every boundary case (`seconds` at exactly 3/15, sharpness at exactly
  500, blank/static at exactly half vs. just over half) and the
  `shouldKeepOriginalTake` retry-decision function `captureSite.ts` uses
  (see `section-clip-recording.md`).
- `runQa.route.test.ts` — the HTTP layer against a mocked `runQa()`
  service: request validation, the uploaded `qa_report.json` shape, the
  "no clips found yet" honest-empty case, and error-path status codes.

**Honest limitation**: `checkClip()`'s real orchestration (`probeVideo`,
`extractGrayscaleFrameRaw`, and the sampling loop) is not run against a
real video file in this environment — only its pure decision logic
(`evaluateMetrics`) and pure pixel math (`imageMetrics.ts`) are tested
directly, plus the HTTP route layer with the whole service mocked.
