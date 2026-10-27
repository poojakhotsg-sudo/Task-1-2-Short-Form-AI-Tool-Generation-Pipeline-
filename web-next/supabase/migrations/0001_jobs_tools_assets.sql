-- Phase 1/2 schema for jobs, tools, and assets (requirement.md Section 8,
-- Section 12 Phase 1). Field choices are grounded in the real current data
-- shapes confirmed in AUDIT.md (not invented):
--   - tools:  mirrors data/tools.json's {price_tier, checkout_url,
--             comment_keyword} exactly (AUDIT.md Section 5).
--   - jobs:   mirrors data/jobs.db's SQLite columns (job_id, url, stage,
--             status, events, tool, slug, type, results, drive, started,
--             updated_at) — reshaped into Postgres types, with stage
--             history pulled out into its own table (job_stages) so
--             per-stage status is queryable instead of buried in a single
--             `events` JSON blob.
--   - assets: mirrors EXTRACT-08's manifest.json entry fields (category,
--             filename, source URL, type, size, width/height, duration,
--             page order, section heading, mp4 copy).
--
-- Open questions to confirm with the project owner before this is final
-- (left as explicit TODOs rather than guessed):
--   1. Object storage key format/convention (Supabase Storage bucket path
--      vs. S3 key) — `storage_key` is a plain text column either way.
--   2. Whether click_events / subscribers (Section 8, MC-03/MC-04) belong
--      in this same migration or a follow-up one — not designed here since
--      this task was scoped to jobs/tools/assets only.
--   3. Whether `jobs.tool_slug` should be NOT NULL — the source app allows
--      standalone extractions (EXTRACT-09) that may predate a tools row;
--      left nullable with ON DELETE SET NULL to match that.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type price_tier as enum ('free', 'paid');

-- Matches PLAT-01's documented statuses exactly, plus 'queued' for the
-- Next.js app's pre-dispatch state (the source app's subprocess model has
-- no equivalent — a job becomes 'running' only once a worker picks it up).
create type job_status as enum (
  'queued', 'running', 'stopping', 'stopped', 'done', 'failed', 'interrupted'
);

-- Matches PIPE-01's eight stages.
create type stage_name as enum (
  'grab', 'describe', 'script', 'match', 'qa', 'trial', 'assemble', 'upload'
);

create type stage_status as enum (
  'pending', 'running', 'done', 'failed', 'skipped'
);

create type asset_kind as enum (
  'extract', 'clip', 'rough_cut', 'lead_magnet', 'hook', 'other'
);

-- ---------------------------------------------------------------------------
-- tools
-- ---------------------------------------------------------------------------

create table tools (
  slug            text primary key,            -- e.g. 'gamma.assets' (source naming convention, EXTRACT-10)
  name            text not null,
  url             text not null,
  price_tier      price_tier not null default 'free',
  checkout_url    text,                         -- null, not '', when absent (source uses '' — normalize on write)
  comment_keyword text,                         -- null, not '', when absent; normalized uppercase A-Z0-9_- by the app layer
  has_reel_kit    boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- MC-02: a comment keyword must be unique across tools. Partial index so
-- multiple tools can each have no keyword (null) without violating this.
create unique index tools_comment_keyword_unique
  on tools (comment_keyword)
  where comment_keyword is not null;

create index tools_has_reel_kit_created_at_idx
  on tools (has_reel_kit desc, created_at desc); -- UI-04's sort order

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------

create table jobs (
  id          uuid primary key default gen_random_uuid(),
  tool_slug   text references tools (slug) on delete set null,
  tool_name   text not null,                    -- denormalized: survives even if the tools row is deleted/renamed
  url         text not null,
  job_type    text not null default 'run',       -- 'run' | 'extract' (source app.py's `type` column)
  status      job_status not null default 'queued',
  requested_stages stage_name[] not null default array[]::stage_name[],
  headed      boolean not null default false,
  drive_folder_url text,                         -- PIPE-10
  error       text,
  -- Idempotency (Section 2.2): a retried Inngest event for the same
  -- logical job must not create a duplicate row. The event handler should
  -- upsert on this key rather than always inserting.
  idempotency_key text unique,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index jobs_tool_slug_created_at_idx on jobs (tool_slug, created_at desc);
create index jobs_status_idx on jobs (status);

-- Per-stage progress, replacing the source app's single `stage` + `events`
-- JSON blob with queryable rows. One row per (job, stage); Inngest step
-- retries upsert this row rather than inserting a new one, which is what
-- makes stage execution idempotent (Section 2.2, acceptance criterion 8).
create table job_stages (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs (id) on delete cascade,
  stage       stage_name not null,
  status      stage_status not null default 'pending',
  message     text,                              -- one-line status message shown in the UI (EXTRACT-08's report.json pattern)
  skipped_reason text,                            -- PIPE-01: "a stage whose prerequisite failed is skipped with a reason"
  log_ref     text,                               -- pointer to full log/diagnostics in object storage, not inline (EXTRACT-08: "diagnostics stay on disk")
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (job_id, stage)
);

create index job_stages_job_id_idx on job_stages (job_id);

-- ---------------------------------------------------------------------------
-- assets
-- ---------------------------------------------------------------------------

create table assets (
  id            uuid primary key default gen_random_uuid(),
  tool_slug     text references tools (slug) on delete cascade,
  job_id        uuid references jobs (id) on delete set null,
  kind          asset_kind not null,
  category      text,                             -- source manifest's free-text category (e.g. 'videos_gifs', 'images') — kept alongside the coarser `kind` enum
  storage_key   text not null,                     -- object-storage key/path; see open question #1 above
  filename      text not null,
  content_type  text,
  source_url    text,                              -- EXTRACT-08: original URL the asset was captured from
  width         integer,
  height        integer,
  duration_seconds numeric,
  size_bytes    bigint,
  page_order    integer,                           -- EXTRACT-08: position on the page
  section_heading text,                             -- EXTRACT-08 / PIPE-02: nearest heading, used for clip naming
  checksum_sha256 text,                             -- EXTRACT-02: exact-dedup key
  mp4_storage_key text,                             -- EXTRACT-05: normalized .mp4 copy, when the original wasn't already mp4
  created_at    timestamptz not null default now()
);

create index assets_tool_slug_idx on assets (tool_slug);
create index assets_job_id_idx on assets (job_id);
create index assets_kind_idx on assets (kind);

-- Idempotency for retried extraction/normalization steps (Section 2.2):
-- the same job re-processing the same source file should upsert, not
-- duplicate. Partial index since checksum is only known for some kinds
-- (e.g. a rough_cut's checksum may not be computed).
create unique index assets_job_checksum_unique
  on assets (job_id, checksum_sha256)
  where checksum_sha256 is not null;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tools_set_updated_at before update on tools
  for each row execute function set_updated_at();

create trigger jobs_set_updated_at before update on jobs
  for each row execute function set_updated_at();

create trigger job_stages_set_updated_at before update on job_stages
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — service-role only (Section 9: never expose service-role credentials
-- to the browser). No anon/authenticated policies are defined because
-- nothing in the current product calls Supabase from the browser; the
-- Next.js server and the worker both use the service-role key, which
-- bypasses RLS. Enabling RLS with no policies still blocks the anon key
-- from ever reading these tables if one is accidentally exposed.
-- ---------------------------------------------------------------------------

alter table tools enable row level security;
alter table jobs enable row level security;
alter table job_stages enable row level security;
alter table assets enable row level security;
