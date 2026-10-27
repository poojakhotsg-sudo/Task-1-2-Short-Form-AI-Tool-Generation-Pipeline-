-- ===========================================================================
-- REEL PIPELINE - FULL DATABASE SCHEMA FOR SUPABASE
-- Run this entire script in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/hrgdvpimqjbvgbvstofa/sql/new
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. ENUMS
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'price_tier') THEN
    CREATE TYPE price_tier AS ENUM ('free', 'paid');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued', 'running', 'stopping', 'stopped', 'done', 'failed', 'interrupted');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stage_name') THEN
    CREATE TYPE stage_name AS ENUM ('grab', 'describe', 'script', 'match', 'qa', 'trial', 'assemble', 'upload', 'extract');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'stage_status') THEN
    CREATE TYPE stage_status AS ENUM ('pending', 'running', 'done', 'failed', 'skipped');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_kind') THEN
    CREATE TYPE asset_kind AS ENUM ('extract', 'clip', 'rough_cut', 'lead_magnet', 'hook', 'other');
  END IF;
END $$;

-- 2. TOOLS TABLE
CREATE TABLE IF NOT EXISTS tools (
  slug            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  price_tier      price_tier NOT NULL DEFAULT 'free',
  checkout_url    TEXT,
  comment_keyword TEXT,
  has_reel_kit    BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tools_comment_keyword_unique
  ON tools (comment_keyword)
  WHERE comment_keyword IS NOT NULL;

CREATE INDEX IF NOT EXISTS tools_has_reel_kit_created_at_idx
  ON tools (has_reel_kit DESC, created_at DESC);

-- 3. JOBS TABLE
CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_slug        TEXT REFERENCES tools (slug) ON DELETE SET NULL,
  tool_name        TEXT NOT NULL,
  url              TEXT NOT NULL,
  job_type         TEXT NOT NULL DEFAULT 'run',
  status           job_status NOT NULL DEFAULT 'queued',
  requested_stages stage_name[] NOT NULL DEFAULT array[]::stage_name[],
  headed           BOOLEAN NOT NULL DEFAULT false,
  drive_folder_url TEXT,
  error            TEXT,
  idempotency_key  TEXT UNIQUE,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_tool_slug_created_at_idx ON jobs (tool_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);

-- 4. JOB STAGES TABLE
CREATE TABLE IF NOT EXISTS job_stages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  stage          stage_name NOT NULL,
  status         stage_status NOT NULL DEFAULT 'pending',
  message        TEXT,
  skipped_reason TEXT,
  log_ref        TEXT,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, stage)
);

CREATE INDEX IF NOT EXISTS job_stages_job_id_idx ON job_stages (job_id);

-- 5. ASSETS TABLE
CREATE TABLE IF NOT EXISTS assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_slug       TEXT REFERENCES tools (slug) ON DELETE CASCADE,
  job_id          UUID REFERENCES jobs (id) ON DELETE SET NULL,
  kind            asset_kind NOT NULL,
  category        TEXT,
  storage_key     TEXT NOT NULL,
  filename        TEXT NOT NULL,
  content_type    TEXT,
  source_url      TEXT,
  width           INTEGER,
  height          INTEGER,
  duration_seconds NUMERIC,
  size_bytes      BIGINT,
  page_order      INTEGER,
  section_heading TEXT,
  checksum_sha256 TEXT,
  mp4_storage_key TEXT,
  purged_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assets_tool_slug_idx ON assets (tool_slug);
CREATE INDEX IF NOT EXISTS assets_job_id_idx ON assets (job_id);
CREATE INDEX IF NOT EXISTS assets_kind_idx ON assets (kind);
CREATE INDEX IF NOT EXISTS assets_purged_at_idx ON assets (job_id) WHERE purged_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS assets_job_checksum_unique
  ON assets (job_id, checksum_sha256)
  WHERE checksum_sha256 IS NOT NULL;

-- 6. CLICK EVENTS TABLE
CREATE TABLE IF NOT EXISTS click_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_slug       TEXT REFERENCES tools (slug) ON DELETE SET NULL,
  keyword         TEXT NOT NULL,
  redirect_target TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS click_events_tool_slug_idx ON click_events (tool_slug);
CREATE INDEX IF NOT EXISTS click_events_keyword_idx ON click_events (keyword);
CREATE INDEX IF NOT EXISTS click_events_occurred_at_idx ON click_events (occurred_at DESC);

-- 7. SUBSCRIBERS TABLE
CREATE TABLE IF NOT EXISTS subscribers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_slug     TEXT REFERENCES tools (slug) ON DELETE SET NULL,
  email         TEXT NOT NULL,
  name          TEXT,
  keyword       TEXT,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS subscribers_email_lower_unique ON subscribers (lower(email));
CREATE INDEX IF NOT EXISTS subscribers_tool_slug_idx ON subscribers (tool_slug);
CREATE INDEX IF NOT EXISTS subscribers_keyword_idx ON subscribers (keyword);

-- 8. STORAGE CLEANUP RUNS TABLE
CREATE TABLE IF NOT EXISTS storage_cleanup_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier           INTEGER NOT NULL,
  job_id         UUID REFERENCES jobs (id) ON DELETE SET NULL,
  storage_key    TEXT,
  deleted_db_row BOOLEAN NOT NULL DEFAULT false,
  ran_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storage_cleanup_runs_job_id_idx ON storage_cleanup_runs (job_id);
CREATE INDEX IF NOT EXISTS storage_cleanup_runs_ran_at_idx ON storage_cleanup_runs (ran_at DESC);

-- 9. UPDATED_AT TRIGGER
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tools_set_updated_at ON tools;
CREATE TRIGGER tools_set_updated_at BEFORE UPDATE ON tools
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS jobs_set_updated_at ON jobs;
CREATE TRIGGER jobs_set_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS job_stages_set_updated_at ON job_stages;
CREATE TRIGGER job_stages_set_updated_at BEFORE UPDATE ON job_stages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 10. ENABLE RLS
ALTER TABLE tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE click_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_cleanup_runs ENABLE ROW LEVEL SECURITY;

-- 11. WORKER ROLE & POLICIES
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'worker_role') THEN 
    CREATE ROLE worker_role LOGIN NOINHERIT; 
  END IF; 
END $$;

GRANT USAGE ON SCHEMA public TO worker_role;
GRANT SELECT ON tools TO worker_role;
GRANT SELECT, UPDATE ON jobs TO worker_role;
GRANT SELECT, INSERT, UPDATE ON job_stages TO worker_role;
GRANT SELECT, INSERT, UPDATE ON assets TO worker_role;

DROP POLICY IF EXISTS worker_select_tools ON tools;
CREATE POLICY worker_select_tools ON tools FOR SELECT TO worker_role USING (true);

DROP POLICY IF EXISTS worker_select_jobs ON jobs;
CREATE POLICY worker_select_jobs ON jobs FOR SELECT TO worker_role USING (true);

DROP POLICY IF EXISTS worker_update_jobs ON jobs;
CREATE POLICY worker_update_jobs ON jobs FOR UPDATE TO worker_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS worker_select_job_stages ON job_stages;
CREATE POLICY worker_select_job_stages ON job_stages FOR SELECT TO worker_role USING (true);

DROP POLICY IF EXISTS worker_insert_job_stages ON job_stages;
CREATE POLICY worker_insert_job_stages ON job_stages FOR INSERT TO worker_role WITH CHECK (true);

DROP POLICY IF EXISTS worker_update_job_stages ON job_stages;
CREATE POLICY worker_update_job_stages ON job_stages FOR UPDATE TO worker_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS worker_select_assets ON assets;
CREATE POLICY worker_select_assets ON assets FOR SELECT TO worker_role USING (true);

DROP POLICY IF EXISTS worker_insert_assets ON assets;
CREATE POLICY worker_insert_assets ON assets FOR INSERT TO worker_role WITH CHECK (true);

DROP POLICY IF EXISTS worker_update_assets ON assets;
CREATE POLICY worker_update_assets ON assets FOR UPDATE TO worker_role USING (true) WITH CHECK (true);
