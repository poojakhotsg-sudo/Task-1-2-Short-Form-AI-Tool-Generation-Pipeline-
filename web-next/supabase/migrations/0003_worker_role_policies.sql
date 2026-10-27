-- RLS policies granting the TypeScript worker (Section 2's "dedicated
-- Node.js/TypeScript worker") scoped write access, instead of handing it
-- the service-role key (which bypasses RLS entirely and can do anything,
-- including rewrite RLS itself). This follows Section 9's least-privilege
-- intent even though that section only names it for the Next.js app.
--
-- Auth pattern chosen (open question — confirm with the project owner):
-- a dedicated LOGIN role with its own password, connected to directly via
-- a Postgres connection string (works with any Postgres client — pg,
-- postgres.js, or supabase-js pointed at a custom connection). This avoids
-- inventing a custom-JWT-signing mechanism for a PostgREST "role" claim,
-- which is the alternative Supabase pattern but needs infrastructure this
-- task wasn't asked to build. If the worker instead calls through
-- PostgREST/supabase-js with a JWT, `worker_role` still works as the
-- target of that JWT's "role" claim — only the connection method differs,
-- not the grants below.
--
-- Scope, grounded in Section 5's Worker Task Contract ("capture_site,
-- extract_media, describe_clips, ... assemble_rough_cut, create_zip,
-- upload_drive"): the worker reads tools/jobs for context, writes its own
-- stage progress, writes the assets it produces, and updates job-level
-- status/error/drive fields. It never touches tools (owned by MC-01, the
-- Next.js app), click_events, or subscribers (MC-03/MC-04, web/ManyChat
-- concerns the worker has no reason to read or write).

create role worker_role login noinherit;
-- Password is NOT set here — never commit a credential to a migration.
-- Set it once via the Supabase dashboard or:
--   alter role worker_role with password '<generated-secret>';
-- and store the resulting connection string as WORKER_DB_URL (see
-- .env.example) — a different secret from WORKER_AUTH_TOKEN, which
-- authenticates the Inngest-to-worker HTTP dispatch, not this DB role.

grant usage on schema public to worker_role;

-- tools: read-only. The worker needs to know a tool's slug/url/price tier
-- to do its job, but tool metadata is written by the Next.js app (MC-01).
grant select on tools to worker_role;

create policy worker_select_tools on tools
  for select to worker_role
  using (true);

-- jobs: read its own assigned work, update status/progress fields. No
-- insert (the Next.js app creates jobs; see src/app/api/jobs/route.ts) and
-- no delete (job history is retained per Section 8's retention rules).
grant select, update on jobs to worker_role;

create policy worker_select_jobs on jobs
  for select to worker_role
  using (true);

create policy worker_update_jobs on jobs
  for update to worker_role
  using (true)
  with check (true);

-- job_stages: full read/write/upsert of its own stage-progress rows — this
-- is exactly what Section 2.2's idempotent-retry requirement needs (the
-- unique(job_id, stage) constraint from migration 0001 is what makes an
-- upsert here safe to retry). No delete — a stage's history shouldn't
-- disappear even if it's later re-run.
grant select, insert, update on job_stages to worker_role;

create policy worker_select_job_stages on job_stages
  for select to worker_role
  using (true);

create policy worker_insert_job_stages on job_stages
  for insert to worker_role
  with check (true);

create policy worker_update_job_stages on job_stages
  for update to worker_role
  using (true)
  with check (true);

-- assets: insert the media it produces, and update on the rare idempotent
-- upsert-by-checksum path (migration 0001's assets_job_checksum_unique).
-- No delete — asset cleanup/retention is an application-level decision
-- (Section 8), not something the worker does unilaterally mid-job.
grant select, insert, update on assets to worker_role;

create policy worker_select_assets on assets
  for select to worker_role
  using (true);

create policy worker_insert_assets on assets
  for insert to worker_role
  with check (true);

create policy worker_update_assets on assets
  for update to worker_role
  using (true)
  with check (true);

-- Explicitly no grants and no policies on click_events or subscribers for
-- worker_role — RLS defaults to deny-all per role when no policy matches,
-- so leaving these tables alone here is sufficient to keep the worker out
-- of them, not an oversight.
