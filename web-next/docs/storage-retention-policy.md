# Storage lifecycle / retention policy

Covers Section 8's "Define retention and cleanup rules for temporary files,
failed-job artifacts, old outputs, and logs," for the `jobs` / `job_stages`
/ `assets` tables (migration 0001) and the key layout in
`object-storage-layout.md`. Does **not** cover `click_events` /
`subscribers` — those may have their own, separate retention obligation
(e.g. a privacy/data-retention policy for lead emails), but that's a
distinct decision this doc isn't making on the project owner's behalf.

Every window below (7 days, 30 days, etc.) is a **proposed default, not a
mandated SLA** — nothing in requirement.md specifies actual numbers. Treat
them as a starting point to confirm or change, not as settled.

## One addition to the storage layout this policy needs: a `tmp/` prefix

`object-storage-layout.md` didn't give in-progress writes their own space
— a stage writing directly to its final key means a crash mid-write leaves
a half-written object sitting at the same path a successful retry would
use. Add:

```
private/tools/<tool_slug>/jobs/<job_id>/tmp/<stage>/...
```

A stage writes here first, and only copies/moves to the final
`.../<stage>/...` key once it reports success to `job_stages`. This is
what makes the "worker restarts and workflow retries leave jobs in a
recoverable state" requirement (Section 9) concrete at the storage level,
and it gives tier 1 below an unambiguous, cheap thing to sweep.

## Retention tiers

| Tier | What | Window | Deletes storage? | Deletes DB rows? |
|---|---|---|---|---|
| 1. Temp/in-progress | `.../jobs/<id>/tmp/**` | 24h after last write | Yes, always | N/A (tmp isn't tracked in `assets`) |
| 2. Failed/interrupted job output | `.../jobs/<id>/**` for jobs with `status in ('failed','interrupted','stopped')` | 7 days after `jobs.updated_at` | Yes — media + manifests both | `assets` rows for that job, then the `job_stages`/`jobs` rows themselves |
| 3. Superseded successful job output | `.../jobs/<id>/**` for `status = 'done'` jobs that are **not** the tool's current job (see below) | 30 days after `jobs.finished_at` | Media only (video/image files) | None — `assets`/`jobs`/`job_stages` rows kept indefinitely as history |
| 4. Lightweight metadata | `manifest.json`, `report.json`, `qa_report.json`, `summary.md`, `run.log`, any text/JSON asset under ~1MB | Indefinite | No | No |
| 5. Current job's output | the tool's most recent `status = 'done'` job | Indefinite, until superseded | No | No |
| 6. Public lead magnets | `public/tools/<slug>/lead_magnet.{html,pdf}` | Indefinite | No, never | No, never |
| 7. Manual uploads | `private/tools/<slug>/manual/**` | Indefinite | No, never | No, never |

"The tool's current job" = `select id from jobs where tool_slug = $1 and
status = 'done' order by finished_at desc limit 1`. Tier 3's sweep must
re-run this query at cleanup time, not cache it — a tool whose only
successful job is 60 days old still has that job protected by tier 5 until
a newer one supersedes it.

Tier 4 exists because Section 8 separately says "Keep generated
manifests/reports and structured error details for troubleshooting" —
these are cheap (small text/JSON) and explicitly meant to survive longer
than the media they describe, even for a superseded or failed job. In
practice this means tier 2/3's sweep deletes `assets` rows whose
`storage_key` extension/content-type is video/image, but leaves rows
pointing at manifest/report/log files alone — or, more simply, leaves the
small files' objects in storage while still deleting the parent job row
once nothing references them (tier 2 only; tier 3 keeps job rows anyway).

## Orphan reconciliation

The worker can fail between writing an object and inserting its `assets`
row (Section 9: "clean up temporary files"). A periodic sweep should list
objects under `private/tools/*/jobs/*/` (excluding `tmp/`) and delete any
object with **no matching `assets.storage_key`** that is also older than
48 hours (the grace window avoids racing an upload that's mid-flight when
the sweep runs). This is independent of tiers 1-3 above — it catches
storage/DB drift, not aged-out-but-consistent data.

## What never gets swept by this policy

- `public/tools/<slug>/lead_magnet.*` — external links (ManyChat messages,
  emailed PDF links from `/api/subscribe`) depend on these staying put
  forever. They're only ever *replaced* (new kit run overwrites the same
  key), never deleted by age.
- `private/tools/<slug>/manual/**` — matches the source's documented
  behavior ("manual clips are retained across runs").
- The tool's current successful job's output (tier 5) and all small
  text/JSON metadata (tier 4), regardless of age.

## Mechanism

Implement as an Inngest scheduled (cron) function — Section 2 already
puts durable orchestration there, and a daily sweep is the same shape as
any other step function (retryable, observable, no secrets in the event
payload). Each tier's sweep should:

1. Select candidates (bounded batch size — Section 9's "bounded
   concurrency," not a single unbounded query against possibly thousands
   of rows).
2. Delete the storage object(s) first, then the DB row — if the object
   delete fails, the DB row stays and the next run retries it. Deleting
   the DB row first and failing the storage delete would leak an orphaned
   object with nothing pointing at it for the reconciliation sweep (above)
   to ever reconsider, since reconciliation only looks at what's
   *unreferenced*, not at what's referenced-but-doomed.
3. Be safe to run twice on the same candidate (idempotent delete — "object
   already gone" / "row already gone" are both success, not errors).

### Auditability of the sweep itself

Since this is a destructive, automated process, it should log what it did
somewhere queryable — not just application logs that rotate away. Proposed
addition (not yet created as a migration; call it out if you want this
turned into one):

```sql
create table storage_cleanup_runs (
  id          uuid primary key default gen_random_uuid(),
  tier        integer not null,         -- which tier above (1-3, or 0 for orphan reconciliation)
  job_id      uuid references jobs (id) on delete set null,
  storage_key text,
  deleted_db_row boolean not null default false,
  ran_at      timestamptz not null default now()
);
```

This also gives a rollback investigation path ("what did we delete and
when") without needing to trust that the deletion logic had no bugs on
day one.

## Explicitly out of scope here

- Actual numeric windows are defaults to confirm, not final (stated above).
- `click_events` / `subscribers` retention — may have separate legal/privacy
  requirements (e.g. "delete subscriber PII after N months on request"),
  which is a product/legal decision, not inferred here.
- Object storage provider lifecycle-policy syntax (S3 Lifecycle Rules vs.
  Supabase Storage's own tooling) — this doc specifies *what* to delete and
  *when*, not which provider-native feature executes it (consistent with
  `object-storage-layout.md` leaving the provider choice open).
