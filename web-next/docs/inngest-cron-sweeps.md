# Inngest cron sweeps — overview

All scheduled (non-event-triggered) Inngest functions in this app, in one
place. Each implements one tier of `storage-retention-policy.md` and is
registered in `src/app/api/inngest/route.ts`. This doc is the index;
tier-specific rationale lives in the policy doc and in each function's own
comments — don't duplicate it here, just point at it.

All schedules and windows below are **defaults to confirm, not settled**
— same caveat as the policy doc they implement.

| Function id | File | Schedule (UTC) | Policy tier | Window | Touches DB rows? |
|---|---|---|---|---|---|
| `cleanup-orphaned-storage` | `src/inngest/functions/cleanupOrphanedStorage.ts` | `0 4 * * *` (daily, 04:00) | 0 — orphan reconciliation | 48h grace period | No — reads `jobs`/`assets`, deletes storage only |
| `cleanup-tmp-storage` | `src/inngest/functions/cleanupTmpStorage.ts` | `0 */6 * * *` (every 6h) | 1 — in-progress/crashed writes | 24h since last write | No — tmp is untracked in `assets` by design |
| `cleanup-failed-job-storage` | `src/inngest/functions/cleanupFailedJobStorage.ts` | `0 3 * * *` (daily, 03:00) | 2 — failed/interrupted/stopped jobs | 7 days since `jobs.updated_at` | Yes — deletes `assets`, `job_stages`, `jobs` rows for the job |
| `cleanup-superseded-job-media` | `src/inngest/functions/cleanupSupersededJobMedia.ts` | `30 3 * * *` (daily, 03:30) | 3 — superseded successful jobs | 30 days since `jobs.finished_at` | Partial — marks `assets.purged_at`, never deletes the row, never touches `jobs`/`job_stages` |

The three daily sweeps are offset by 30-60 minutes (03:00 / 03:30 / 04:00)
only so they don't contend for the same rows in the same instant — tier 2
and tier 3 are mutually exclusive by job status (`failed`/`interrupted`/
`stopped` vs. `done`), and tier 0 only ever reads `jobs`/writes storage +
`storage_cleanup_runs`, so this spacing is belt-and-suspenders, not a real
collision risk. Tier 0 runs after both daily DB-mutating sweeps (04:00,
after 03:00/03:30) so a storage object tier 2 or 3 is actively processing
in the same night's run doesn't get second-guessed mid-flight by tier 0's
own run — though since all four sweeps are independently idempotent, this
ordering is a courtesy, not a correctness requirement.

## Shared dependencies

- **`src/lib/objectStorage.ts`** — the only file that talks to the actual
  storage provider's API (currently Supabase Storage). All four sweeps go
  through it (`deleteAllUnderPrefix`, `deleteKeys`, `listStaleTmpKeys`,
  `listJobObjectsExcludingTmp`) rather than calling `supabase.storage`
  directly, so a provider switch only means rewriting this one file.
- **`storage_cleanup_runs`** (migration `0004`) — shared audit table.
  Tiers 0, 2, and 3 all write to it; tier 1 currently does not (it logs via
  `logger.info` only — see "Gaps," below).
- **`assets.purged_at`** (migration `0005`) — only tier 3 writes this.

## Env vars these sweeps need

From `.env.example`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (all four
go through `getSupabaseServerClient()`), and `OBJECT_STORAGE_BUCKET` /
`OBJECT_STORAGE_PRIVATE_BUCKET` (storage access — `objectStorage.ts` falls
back from the latter to the former). None of the four need
`OBJECT_STORAGE_PUBLIC_BUCKET` — by construction, none of them ever touch
`public/tools/<slug>/lead_magnet.*` (tier 6, never swept) or
`private/tools/<slug>/manual/**` (tier 7, never swept) — tier 0's walk
only ever enters a job's own folder, never a tool's `manual/` folder,
specifically to keep that true without relying on a runtime check.

## Operational notes

- **Bounded batches, not unbounded sweeps** (Section 9's "bounded
  concurrency"): tiers 2 and 3 cap candidates per run at 25 jobs; tiers 0
  and 1 cap the storage-listing side at 500 keys. A large backlog clears
  over several days of runs, not one run. This is a deliberate tradeoff,
  not an oversight — see each function's own comments for the specific
  number chosen. The one exception is tier 0's *other* side: the query
  for which storage keys are still referenced in `assets` is deliberately
  NOT bounded by a single capped read — it paginates through the whole
  table instead, because under-fetching that set would mean treating a
  real, live asset as an orphan and deleting it. Bounding the storage-
  listing side only costs time (safe); bounding that query would be a
  correctness bug.
- **Idempotent by construction**: every delete tolerates "already gone" as
  success, and tiers 0/2/3's DB writes are structured so a retry
  mid-function doesn't double-apply (step-per-job/step-per-phase
  granularity via Inngest's step memoization, plus the underlying
  operations being safe to repeat regardless). Tier 3 has one known,
  accepted exception: a fully-purged superseded job keeps getting
  re-selected as a "candidate" on every run forever (nothing marks it
  done), which wastes a little work but never double-deletes or
  double-writes — see `cleanupSupersededJobMedia.test.ts`'s idempotency
  test for the exact behavior.
- **Tier 0's audit rows need a live FK target, and can't assume one.**
  Unlike tier 2 (where the job row is guaranteed to still exist at the
  moment the audit row is inserted, and is only deleted afterward), a
  tier-0 orphan's job row may *already* be gone — that's one of the
  realistic ways an orphan gets created in the first place (tier 2 failed
  partway through deleting a job's storage). `cleanupOrphanedStorage.ts`
  checks which extracted job IDs still exist before inserting, and sets
  `job_id: null` for the rest, rather than letting the insert fail
  outright on a dangling FK reference.
- **Deploying these for the first time**: run each once manually (Inngest
  supports manual invocation outside the cron schedule) against a
  non-production environment before trusting the schedule, since these
  are destructive.

## Test coverage

All four sweeps have integration-style tests (`src/inngest/functions/
__tests__/`) against a faithful in-memory fake of the exact Supabase
query-builder and Storage operations each one calls (`src/test/
fakeSupabase.ts`) — not mocks of internal helpers, but a substitute for
`getSupabaseServerClient()` itself, so the real sweep code and the real
`objectStorage.ts` run unmodified against it. Run with `npm test`.

**Honest limitation, repeated because it matters**: there is no
Docker/local Postgres available in this environment, so none of this has
been verified against an actual running Supabase project or storage
bucket — only against the fake, plus `tsc --noEmit` and `next build`.
Writing these tests already caught and fixed two real bugs before this
caveat could hide them: tier 1 was walking the wrong storage path
entirely (a silent no-op in production), and the test fake's own
multi-`.order()` sort had the wrong precedence. Treat that as evidence
the exercise is worth doing, not as a substitute for an eventual real
integration run.

## Gaps against the full policy (tracked here, not hidden)

1. **Tier 1 doesn't write to `storage_cleanup_runs`.** It has no job_id to
   attach an audit row to (tmp objects aren't tied to a tracked job row in
   a way this function looks up), so it logs via `logger.info` instead.
   If cross-tier audit queries ("show me everything deleted on date X")
   turn out to matter, tier 1 would need either a nullable-job-id audit
   path or its own log table — not built now because nothing today
   indicates it's needed.
2. **None of this has run against real data.** Verified by `tsc --noEmit`,
   `next build`, and the fake-backed test suite only — no integration test
   against an actual Supabase project or storage bucket exists yet (see
   "Test coverage," above).
