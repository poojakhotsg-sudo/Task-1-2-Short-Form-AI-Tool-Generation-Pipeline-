# Section-clip recording (PIPE-02)

`/tasks/capture_site`'s real implementation, ported from
`pipeline/grabber.py`'s `grab()` / `_record_library()` "pass 1" (source
lines 1319-1422). This doc exists for the same reason the `web-next`
docs do: say plainly what's ported, what's flagged as not, and why.

## What this does

1. Launches a mobile-emulated (`devices['iPhone 14']`, 390×844) Chromium
   context with context-wide video recording enabled.
2. Loads the page (`pageInteraction.ts`'s `loadPage`/`preparePage`):
   cookie-popup dismissal, chat-widget hiding, bot-check detection with
   retry, a scroll-through pass to trigger lazy-loaded content.
3. Extracts rich site data (`siteData.ts`'s `SITE_DATA_JS` — title,
   description, headings, feature text, video/embed/image URLs, where
   the hero section ends) and a hero screenshot sized to it.
4. Finds content blocks on the page (`pageInteraction.ts`'s
   `FIND_BLOCKS_JS`) and picks up to 8 distinct sections
   (`pageSections.ts`'s `pickSections`).
5. For each picked section, scrolls in, hovers over visible elements with
   a fake cursor, and drifts down (`recordShot.ts`'s `recordShot`/
   `hoverAround`) — all while the context's video recording is running
   continuously.
6. Closes the context (finalizing the one continuous video) and cuts
   each section's `[start, end]` window out of it into its own
   1080×1920 H.264 clip (`lib/ffmpeg.ts`'s `cutClipToVertical`).
7. **Pass 2, the static-clip motion retry** (`grabber.py` lines
   1424-1468): every pass-1 clip is checked with `checkClip()`
   (`qa/checkClip.ts`, PIPE-06 — the same logic `/tasks/run_qa` exposes
   over HTTP, called directly in-process here rather than via an
   internal HTTP round-trip). Any clip `isStatic()` flags gets a second
   recording session: `recordMotion()` plays the section's video(s) and
   scrolls slowly through it while hovering, instead of `recordShot()`'s
   single scroll-in/hover/drift. The retry is re-cut, re-checked, and
   kept only if `shouldKeepOriginalTake()` says it's actually less
   static than the original — a retry that doesn't improve things is
   discarded, matching the source's exact comparison, not "always prefer
   the retry."
8. The route handler uploads the hero screenshot, site data, each clip
   (under this stage's `clips/` subfolder — the same path
   `web-next`'s `match.ts` Rule 1b and `describe_clips`'s clip listing
   both already expect), and a `library.json` summary (now including
   each clip's QA result and whether it was retried).

## Not ported in this pass — flagged, not silently dropped

1. **Network/embedded video downloads** (`download_videos`/
   `download_embeds`, yt-dlp-based) — EXTRACT-03-shaped work, a
   different kind of task than section-clip recording, not attempted.
2. **The shot_list-aware per-shot recording path** (`_find_shot_sections`
   + `clip_name()`-named clips within `grab()` itself). `grabber.py`
   only takes this path when `shot_list.json` already exists at grab
   time. In this pipeline's dependency graph
   (`web-next/src/inngest/functions/stageGraph.ts`), `grab` always runs
   before `script`, so `shot_list.json` never exists yet when this
   runs — that branch is dead code for us by construction, not
   something worth porting. (`match.ts`'s Rule 1b still reproduces the
   *naming convention* `clip_name()` defines, independently — that part
   is real and already wired up on the `web-next` side.)
3. **qa.py's broader manifest bookkeeping** (`annotate`,
   `refresh_clip_map`, the `shots`/`clips`/`needs_trial` map in a single
   manifest.json) — this worker's `/tasks/run_qa` reports facts about
   each clip file only (`qa_report.json`); the DB/job-state side of
   "which shots still need a trial recording" is `web-next`'s job once
   real shot assignments exist (match.ts), not this worker's.

## A real discrepancy this caught, not just a style note

Python's `round()` uses round-half-to-even (banker's rounding);
JavaScript's `Math.round()` always rounds half up. `pick_sections()`'s
index-spreading formula hits exactly `.5` for common inputs (e.g. 10
sections spread across `maxN=3` picks index `4.5`), so a naive port
would pick a *different* section than the source does — not a cosmetic
difference, a different recorded clip. Confirmed directly in Python
(`round(4.5) == 4`, not 5) rather than assumed from memory, then fixed
with an explicit `roundHalfToEven()` in `pageSections.ts`.
`pageSections.test.ts` asserts the exact corrected index set, not just
"some reasonable spread."

## PIPE-06 (`/tasks/run_qa`) — see it in full there

`checkClip()`, its pure decision logic (`evaluateMetrics`), the pixel
math behind it (`imageMetrics.ts`'s `laplacianVariance`/`stddev`/
`meanAbsDiff`), and `/tasks/run_qa` itself are documented in
`run-qa.md`, not repeated here. One deviation specific to how
`captureSite.ts` *uses* that logic: Python's pass 2 compares the retry's
`metrics.get('motion', 0)` against the *original* clip's motion metric
before the retry happened — ported as `shouldKeepOriginalTake()`
(`qa/checkClip.ts`), tested directly with synthetic motion values rather
than through a real retry recording.

## Test coverage

- `pageSections.test.ts` — pure unit tests of `pickSections`/
  `libraryName`/`slugify` (no browser needed), including the
  round-half-to-even case above.
- `captureSite.route.test.ts` — the HTTP layer against a mocked
  `captureSite()`: upload keys/content-types, the `library.json` shape
  (including QA/retry fields), honest reporting of per-section failures
  and QA pass counts in the response message, and error-path status
  codes.
- `checkClip.test.ts`'s `shouldKeepOriginalTake` tests — the pass-2
  keep-vs-replace decision, exercised directly with synthetic
  before/after motion values (see `run-qa.md` for the rest of that
  file's coverage).

**Honest limitation, same as every other turn's work here**: `captureSite()`
itself — the Playwright navigation, video recording, and ffmpeg cutting,
including both recording passes — is not run against a real browser or a
real page in this environment. Only its pure sub-pieces (`pageSections.ts`,
`qa/checkClip.ts`'s decision functions) and the HTTP route layer (with
`captureSite()` mocked) are tested. The scroll/hover/drift timing, the
video-recording-and-cut pipeline, and the actual ffmpeg/ffprobe invocations
have been read against the real Playwright and ffmpeg APIs/docs for
correctness, but not executed end-to-end here.
