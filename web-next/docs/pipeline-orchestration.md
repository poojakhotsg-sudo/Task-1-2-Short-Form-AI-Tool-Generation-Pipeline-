# Pipeline orchestration — Phase 3

The `run-reel-pipeline` Inngest function (`src/inngest/functions/
runReelPipeline.ts`), triggered by the `reel/job.created` event that
`POST /api/jobs` and `POST /api/extract-assets` already emit (Phase 2).
Implements requirement.md Section 12's Phase 3: "stage-by-stage
workflows, retries, idempotency, progress updates, and cancellation
requests."

## Scope of this pass — real orchestration, stubbed stage content

Phase 3's job, per Section 12, is the *workflow engine*: sequencing,
dependency-aware skipping, state writes, retries, cancellation. It is not
the actual browser-automation/ffmpeg work (that's Phase 4, the TypeScript
worker) or the AI-prompt logic for script generation and clip matching
(separate, substantial ports of `pipeline/script_gen.py` and
`pipeline/matcher.py`). This pass draws that line explicitly rather than
blurring it:

- **Real**: the dependency graph, the stage loop, job_stages/jobs state
  writes, the worker HTTP client, cooperative + platform-level
  cancellation, idempotency. As of a later pass, also `describe`,
  `match`, and `script` (see their own sections below) — this doc is
  updated as each stage moves from stub to real, not left describing an
  earlier state.
- **Phase 4 (the worker) now exists, for five of six delegated stages**:
  `grab` (`/tasks/capture_site`), `describe` (`/tasks/describe_clips`),
  `qa` (`/tasks/run_qa`), `assemble` (`/tasks/assemble_rough_cut`),
  `script`'s site-text prerequisite (`/tasks/fetch_site_text`), and —
  as of this pass — `match`'s per-shot mobile-recording fallback
  (`/tasks/record_missing_shot_clips`) have real implementations in
  `reel-pipeline/worker/` — see that project's own `docs/` for what each
  one actually does and doesn't do yet. `trial` and `upload` still call
  `callWorkerTask()` against endpoints that don't exist on the worker
  (404s today, not a bug in this code).

Running the full 8-stage pipeline today will reach `grab`/`describe`/
`script`/`match` against a real worker (if `WORKER_BASE_URL` points at
one and an LLM API key is configured), and fail wherever `trial` or
`upload` actually run (they call worker endpoints that don't exist yet)
— `qa` and `assemble`, which only depend on `match`, now run for real
too.

**Correction from this pass**: `script` was described below as "not in
Section 5's task list... not browser/ffmpeg work," full stop. Reading
`pipeline/script_gen.py` in full (not just PIPE-04's one-line summary)
showed it also runs its own independent Playwright pass
(`fetch_site_text()`) to collect site text + embedded-demo-video info
before ever calling an LLM — the same kind of discovery `match`'s
correction note below already describes for `record_missing_shot_clips`.
So `script` is a hybrid: `src/inngest/stages/script.ts` owns the real
LLM-prompt + validation + retry logic (ported into `script/
generateReel.ts`, `script/validateReel.ts`, `script/renderScript.ts`),
but it delegates the site-text fetch to the worker's
`fetch_site_text` task rather than running Playwright in this app.

**Correction from the original version of this doc**: `match` was
claimed below to need "no worker call." That was wrong — confirmed by
actually reading `pipeline/matcher.py` (not re-derived from PIPE-05's
one-line summary) when porting it. The matching rules themselves (script-
specified clip, per-shot clip-name lookup, LLM/vision scoring) are pure
API/storage calls and genuinely need no worker — but the source's
`match()` also calls `grabber.record_missing_shot_clips()` for any shot
still unmatched after those rules, which records NEW clips via
Playwright. That fallback is now ported too, as the worker's
`/tasks/record_missing_shot_clips` — see `match.ts`'s own file-level
comment and the worker's `docs/record-missing-shot-clips.md`.

That same doc also flags a real bug the port fixes rather than carries
forward: in the source, `grabber.py`'s heading-matching inside
`record_missing_shot_clips()` only runs for a shot whose dict has
`"status": "pending"` — a field `matcher.py`'s `build_shots()` never
sets. So every call from `match()` in the source finds 0 headings and
silently degrades to "mark missing," regardless of whether a matching
heading actually exists — the whole function is a no-op in its only
real caller. This port attempts heading-matching for every shot the
caller passes in instead, restoring the function's documented intent.

## Stage graph (`src/inngest/functions/stageGraph.ts`)

Pure data + one pure function, deliberately free of Inngest/Supabase/the
worker client so it's unit-testable on its own
(`stageGraph.test.ts`):

```
grab:     []
describe: [grab]
script:   []
match:    [grab, script]
qa:       [match]
trial:    [match]
assemble: [match]
upload:   [assemble]
```

Exactly PIPE-01's documented dependencies — `grab` and `script` have no
listed prerequisite. `STAGE_ORDER` (`grab -> describe -> script -> match
-> qa -> trial -> assemble -> upload`) is PIPE-01's documented default
order, and is verified (by a test, not just by eye) to be a valid
topological order of the graph above.

## Stage-to-task mapping

| Stage | Worker task | Notes |
|---|---|---|
| `grab` | `capture_site` | PIPE-02 |
| `describe` | `describe_clips` | PIPE-03 — worker makes the vision-model call itself, since the extracted frames are already there; round-tripping them through this app would mean handling media bytes here (Section 2.1 says not to) |
| `script` | `fetch_site_text` (prerequisite only) | PIPE-04, ported. The LLM-prompt + validation + retry logic (`script/generateReel.ts` etc.) runs in this app, not the worker — only `fetch_site_text()`'s Playwright site-text fetch is delegated, for the same reason `match`'s correction note below explains |
| `match` | `record_missing_shot_clips` (fallback only) | PIPE-05, ported. Script-specified/per-shot-name/vision-scoring rules are pure API+storage calls, no worker needed; any shot still unmatched after those now gets one more mobile-recording pass via the worker — see the correction note above for the one real bug this port fixes rather than carries forward |
| `qa` | `run_qa` | PIPE-06 |
| `trial` | `record_trial_steps` | PIPE-07. **Not in Section 5's explicit task list** — that list is introduced with "such as," i.e. non-exhaustive. Added because trial recording needs the same Playwright capability `capture_site` already needs, and nothing else can do it. Flagged here and in `workerClient.ts` rather than silently treated as if Section 5 had named it. |
| `assemble` | `assemble_rough_cut` | PIPE-09 |
| `upload` | `upload_drive` | PIPE-10 |

## Worker client (`src/lib/workerClient.ts`)

`callWorkerTask(task, payload)` — authenticated HTTP POST to
`${WORKER_BASE_URL}/tasks/${task}` with `Authorization: Bearer
${WORKER_AUTH_TOKEN}`. Payloads carry job IDs, tool slugs, URLs, and
object-storage *prefixes* (via `stageStoragePrefix()`,
`src/inngest/stages/types.ts`) — never media bytes, matching Section 2.1
exactly. This is the one file that would need to change if the
worker-dispatch mechanism changes (e.g. from HTTP to a queue) — every
stage executor goes through it rather than calling `fetch` directly.

## State writes (`src/lib/jobState.ts`)

Three small functions, independently testable:

- `setJobStatus(jobId, status, extra)` — updates the `jobs` row.
- `isJobStopping(jobId)` — reads whether `jobs.status === 'stopping'`.
- `upsertStageStatus(jobId, stage, fields)` — upserts on `(job_id,
  stage)`, the unique constraint from migration `0001`. This is what
  makes a retried stage-step idempotent: it overwrites the same row
  rather than inserting a duplicate.

## Idempotency

Each requested stage runs inside exactly one `step.run('run-stage-
<stage>', ...)`. If Inngest retries that step (e.g. after a crash before
it returned), the whole thing — the worker call and the `job_stages`
writes — re-runs from scratch. That's safe because:

- The worker writes to the same deterministic storage key every time
  (object-storage-layout.md's convention), so a repeated write overwrites
  rather than duplicates.
- `upsertStageStatus` overwrites the same `(job_id, stage)` row rather
  than inserting a new one.

If the step already returned successfully before a retry, Inngest's step
memoization replays that return value directly — the stage doesn't
re-run at all in that case.

## Cancellation — two layers, not one

`run-reel-pipeline` has `cancelOn: [{ event:
'reel/job.stop-requested', match: 'data.jobId' }]` — a real Inngest
feature (verified against the installed `inngest@4.26.0` types before
using it, not assumed), confirmed by probing `node_modules/inngest/
types.d.ts`. This is a platform-level safety net: Inngest won't schedule
further steps once a matching cancel event arrives. But it's
best-effort — it can't interrupt a step already executing, and this
app's own code has no hook to observe exactly when it takes effect in
order to make a clean "mark the job stopped" DB write.

So there's a second, cooperative layer: before each stage (and once
again before the very first one — see below), the orchestrator itself
checks `isJobStopping()` and, if true, writes `jobs.status = 'stopped'`
and returns. `DELETE /api/jobs/:id` sets `jobs.status = 'stopping'`
*directly*, in addition to emitting the event — that DB write is what
this check actually depends on, independent of whether or when Inngest's
own cancellation lands.

**A real bug this caught**: the first version of this function
unconditionally set `jobs.status = 'running'` before the loop's first
per-stage cancellation check. A stop request arriving in the window
between job creation and the function starting would get clobbered —
`mark-job-running` would silently overwrite `'stopping'` back to
`'running'` before the first check ever ran. Fixed by adding an explicit
`check-cancelled-at-start` step before that write, caught by
`runReelPipeline.test.ts`'s cancellation test failing against the
original version (not found by inspection — the bug was exercised and
caught by actually running the test, same as the two bugs the retention-
sweep tests caught in the previous pass).

## `GET`/`DELETE /api/jobs/:id` — completed, not just orchestration

These were Phase 2 stubs waiting on exactly the schema and writes this
pass provides. Completed as part of this work since there's no point
building an orchestrator with nothing able to observe its output:

- `GET` now reads the real `jobs` + `job_stages` rows.
- `DELETE` now writes `jobs.status = 'stopping'` directly (see
  "Cancellation," above) before emitting the cancel event.

## Test coverage

- `stageGraph.test.ts` — pure unit tests of the dependency graph and
  `unmetPrerequisite()`, no mocking needed.
- `runReelPipeline.test.ts` — integration-style tests against the same
  `fakeSupabase.ts` harness as the retention sweeps, plus a mock of
  `workerClient.callWorkerTask` to control per-task success/failure
  without real HTTP. Covers: a subset pipeline succeeding end to end, the
  a failed stage correctly skipping everything downstream, prerequisite-failure
  skipping with the right reason, stages not requested at all never being
  touched, and the cancellation-before-start bug above.
- `match/__tests__/scriptParser.test.ts` — pure unit tests of the
  `parse_script`/`build_shots`/`clip_name` port against the exact Python
  behavior (confirmed directly in Python where a prediction was
  non-obvious, e.g. the "any non-empty shot_list wins" quirk — not just
  read off the source and assumed).
- `match/__tests__/match.test.ts` — integration-style tests of the full
  rule chain (script-specified clip, per-shot clip-name, vision scoring,
  used-clip exclusion, missing-shot marking, trial shots skipping
  matching entirely) against `fakeSupabase.ts`, extended in this pass
  with `download`/`upload` support since no earlier stage needed to read
  or write actual object *content* before (the retention sweeps only
  ever listed/deleted keys).
- `match/__tests__/match.rule2.test.ts` — dedicated to Rule 2's scoring
  path specifically: the 0.5 confidence boundary (inclusive at exactly
  0.5), score rounding to 2 decimals, highest-score-wins among several
  candidates, ignoring a scored file the model names that isn't actually
  in the catalog it was given, the exact call shape passed to
  `scoreCatalogAgainstLine` (script line + `{file, caption, tags, has_ui,
  clip_type}[]`), Rule 2 being skipped once Rule 1/1b already resolved a
  shot, and — documented as current behavior, not asserted as a design
  goal — that match.ts has no defensive `try/catch` around the scoring
  call, so a scoring rejection fails the entire stage rather than just
  marking that one shot missing. That last point relies entirely on
  `clipScoring.ts`'s own "always resolves, never throws" contract
  holding; nothing in `match.ts` double-checks it.

**Honest limitation, repeated because it matters**: no real Supabase
project, no real Inngest runtime, and no real Phase 4 worker exist to
test against in this environment — these are integration tests of this
app's own orchestration logic against faithful fakes of its two
dependencies (the DB and the worker HTTP boundary), not an end-to-end run
of an actual pipeline.

## What's left for Phase 3 to be "done"

1. ~~Port `pipeline/script_gen.py`'s LLM-prompt + validation logic into
   `src/inngest/stages/script.ts`.~~ Done — see `script.ts`,
   `script/generateReel.ts`, `script/validateReel.ts`,
   `script/renderScript.ts`, `script/schema.ts`, and their tests, plus
   the worker's `fetch_site_text` task for the Playwright prerequisite.
2. ~~Port `pipeline/matcher.py`'s clip-to-shot matching algorithm into
   `src/inngest/stages/match.ts`, including the `record_missing_shot_clips`
   fallback.~~ Done — see `match.ts`, `match/scriptParser.ts`,
   `match/clipScoring.ts`, the worker's `recordMissingShotClips.ts`/
   `headingMatch.ts`, and their tests. Remaining: Rule 3's keyword-
   overlap matching against grab-stage "library" metadata (needs
   `capture_site` to actually record section clips with heading/text
   metadata first, which it doesn't yet).
3. Everything downstream of `match` (`qa`, `trial`, `assemble`,
   `upload`) is already wired to call the worker correctly — `trial` and
   `upload` just have nothing real to call until their worker tasks
   exist.
4. Decide whether a fully-purged-forever-recandidated inefficiency class
   of issue (like tier 3's from the retention-sweep work) exists here
   too — not identified in this pass, but worth a deliberate check once
   Phase 4 is real and this runs against actual jobs.
