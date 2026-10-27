# Object storage key layout — jobs / tools / assets

Grounds the `storage_key` / `mp4_storage_key` columns from
`supabase/migrations/0001_jobs_tools_assets.sql` in an actual convention.
Provider-agnostic by design (Section 6 hasn't finalized Supabase Storage vs.
an S3-compatible store) — the layout below is a key/prefix scheme that works
under either.

## Behavior change from the source app — flag before building

**The source app's `/out` mount is fully public with no auth at all**
(`app.mount("/out", StaticFiles(directory=OUT), ...)`, app.py:68) — every
extracted image, clip, manifest, rough cut, and log is publicly fetchable
today by guessing/crawling a URL, not just the lead magnet. Section 9 of
requirement.md calls for "signed or otherwise access-controlled download
URLs where outputs are not public." Following that (private-by-default,
signed URLs) is a deliberate **tightening**, not a 1:1 port — confirm this
is wanted before treating it as settled, since it's a real behavior change
a careless "parity" pass could miss in either direction.

## Public vs. private split

Only two file types have a documented reason to be genuinely, permanently
public (no signed-URL expiry): **`lead_magnet.html`** and
**`lead_magnet.pdf`**. They're linked directly from ManyChat messages and
`/api/subscribe`'s `pdf_url` response (MC-04) — an expiring signed URL would
break old chat messages and emailed links. Everything else (extraction
media, clips, rough cuts, manifests, logs, catalogs, scripts, QA reports,
hooks.json, the lead magnet's source `lead_magnet.json`) stays private,
served only via signed URLs issued by the Next.js app's server-side
Supabase/S3 client.

- **If Supabase Storage**: its public/private flag is per-*bucket*, not
  per-prefix, so this requires two buckets: `reel-public` and
  `reel-private`.
- **If S3-compatible storage**: a single bucket works, using a bucket
  policy that grants public `GetObject` scoped to the `public/*` prefix
  only.

The key layout below uses a `public/` vs `private/` top-level segment
either way, so the scheme reads the same regardless of which provider wins
— under Supabase Storage, drop the segment and let the bucket choice carry
that meaning instead; under S3, keep it, since it's load-bearing for the
bucket policy.

## Layout

```
private/tools/<tool_slug>/jobs/<job_id>/extract/videos_gifs/<filename>
private/tools/<tool_slug>/jobs/<job_id>/extract/images/<filename>
private/tools/<tool_slug>/jobs/<job_id>/extract/raw/<filename>
private/tools/<tool_slug>/jobs/<job_id>/extract/manifest.json
private/tools/<tool_slug>/jobs/<job_id>/extract/report.json
private/tools/<tool_slug>/jobs/<job_id>/extract/run.log

private/tools/<tool_slug>/jobs/<job_id>/grab/clips/<filename>        # clipNN_<heading>.mp4, site_videoNN_segNN.mp4
private/tools/<tool_slug>/jobs/<job_id>/grab/hero.png
private/tools/<tool_slug>/jobs/<job_id>/grab/mobile_check.png
private/tools/<tool_slug>/jobs/<job_id>/grab/site_data.json
private/tools/<tool_slug>/jobs/<job_id>/grab/manifest.json

private/tools/<tool_slug>/jobs/<job_id>/describe/clip_catalog.json

private/tools/<tool_slug>/jobs/<job_id>/script/script.txt
private/tools/<tool_slug>/jobs/<job_id>/script/shot_list.json

private/tools/<tool_slug>/jobs/<job_id>/qa/qa_report.json

private/tools/<tool_slug>/jobs/<job_id>/trial/<filename>             # trialNN_<name>.mp4 + matching .png

private/tools/<tool_slug>/jobs/<job_id>/assemble/rough_cut.mp4
private/tools/<tool_slug>/jobs/<job_id>/assemble/summary.md

private/tools/<tool_slug>/jobs/<job_id>/kit/hooks.json
private/tools/<tool_slug>/jobs/<job_id>/kit/page_text.txt
private/tools/<tool_slug>/jobs/<job_id>/kit/lead_magnet.json

public/tools/<tool_slug>/lead_magnet.html                            # mirrored out of kit/, not job-scoped — see below
public/tools/<tool_slug>/lead_magnet.pdf

private/tools/<tool_slug>/manual/<shot_id>/<uuid>.<ext>              # manual clip uploads, UI-01 — see below
```

### Why `jobs/<job_id>/<stage>/...` instead of flat `tools/<tool_slug>/...`

The source writes one flat `out/<tool>/` tree per tool, overwritten on every
rerun. That's fine for a single-job-at-a-time server (PLAT-01's global
`is_job_running()` lock), but Section 2.2 requires idempotent retries and
Phase 1 is trying to lift exactly that global-lock constraint eventually.
Scoping keys by `job_id` means:

- A retried stage overwrites its own deterministic key — correct
  idempotent behavior, not a duplicate.
- Two jobs for the same tool (a rerun while comparing against a prior
  result, or eventually concurrent jobs) never collide or silently
  clobber each other's output.
- `assets.job_id` (migration 0001) already carries this scoping at the DB
  level — the storage key just mirrors it instead of inventing a second,
  disconnected scheme.

The cost: there's no single "current" key for a tool's rough cut — the
latest one is found by querying `jobs`/`assets` for the tool's most recent
completed job, not by a fixed path. That's intentional: keeping storage
"dumb" (no copy-to-latest step, no symlink-equivalent) means one write per
output, not two, and the database is already the source of truth for
"what's current."

### The `kit/` → `public/` mirror is a real duplication, not a shortcut

`lead_magnet.html`/`.pdf` get written twice: once under the job-scoped
`kit/` path (for audit/history — which job produced which version) and
once at the stable, job-independent `public/tools/<tool_slug>/` path (what
ManyChat and `/api/subscribe`'s `pdf_url` actually link to). The worker
task that generates these is responsible for both writes. This is the one
place in the layout where storage isn't "dumb" — flagging it explicitly
rather than letting it look like an oversight.

### Manual clip uploads are tool-scoped, not job-scoped

UI-01: "Uploaded `_manual` clips are retained across runs." A manual
upload isn't produced by any job, so it doesn't belong under `jobs/<id>/`
— it would vanish from relevance the moment that job's record ages out.
`<shot_id>` identifies which shot it replaces (matching the source's
`_manual` naming convention); `<uuid>` avoids collisions on re-upload
without needing a second lookup before writing.

## Filename convention

Stage logic keeps emitting the same filenames the source already produces
(`clipNN_<heading>.mp4`, `00_page_scroll.mp4`, `site_videoNN_segNN.mp4`,
`trialNN_<name>.mp4`) — the object key doesn't re-number or re-encode
anything. Two reasons: Phase 6's regression testing needs to diff the new
output against the Python baseline, and the ordering is already meaningful
(page/section order), so inventing a different numbering scheme would be
pure risk for no benefit.

## Mapping to `assets.storage_key`

- `assets.storage_key` stores the full key exactly as written above
  (including the `public/`/`private/` segment).
- `assets.mp4_storage_key` (EXTRACT-05's normalized-copy column) is the
  sibling key in the same folder with a `.mp4` extension — e.g. a
  `.webm` at `private/.../extract/videos_gifs/demo.webm` has
  `mp4_storage_key = private/.../extract/videos_gifs/demo.mp4`.
- `job_stages.log_ref` (migration 0001) points at the matching
  `.../extract/run.log` or equivalent per-stage log key — kept out of the
  `assets` table since a log isn't a pipeline *output*, it's diagnostics
  (EXTRACT-08: "diagnostics stay on disk; the UI receives only the
  one-line message").

## Open questions (not resolved here)

1. **Provider choice** (Supabase Storage vs. S3-compatible) — determines
   whether the `public`/`private` segment is load-bearing (S3 bucket
   policy) or redundant-but-harmless documentation (two Supabase buckets).
2. **Retention** (Section 8: "Define retention and cleanup rules for
   temporary files, failed-job artifacts, old outputs, and logs") — this
   layout makes a lifecycle rule like "delete `private/tools/*/jobs/*`
   older than N days, except the job a tool's current `assets` rows
   reference" straightforward to write, but the actual N and the
   exception logic aren't decided here.
3. **ZIip downloads** (PLAT-04, UI-02's zip-selected): not given a storage
   key at all — designed as built-on-demand from existing keys and
   streamed/signed-URL'd, not persisted, so they don't go stale. If
   caching them turns out to be worth it later, that's a separate,
   explicit decision, not an accidental consequence of this layout.
