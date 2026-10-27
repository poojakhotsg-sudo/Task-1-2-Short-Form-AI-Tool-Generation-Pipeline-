-- Audit log for the storage retention sweeps (storage-retention-policy.md).
-- Proposed in that doc, created here because the tier-2 cron function
-- (src/inngest/functions/cleanupFailedJobStorage.ts) writes to it.

create table storage_cleanup_runs (
  id             uuid primary key default gen_random_uuid(),
  tier           integer not null,       -- 1-3 per storage-retention-policy.md, or 0 for orphan reconciliation
  -- Nullable + ON DELETE SET NULL: the whole point of this table is to
  -- outlive the job row it describes — once the job is deleted, rows here
  -- naturally lose the FK target but keep the audit trail.
  job_id         uuid references jobs (id) on delete set null,
  storage_key    text,                    -- null on the summary row marking "job rows deleted"
  deleted_db_row boolean not null default false,
  ran_at         timestamptz not null default now()
);

create index storage_cleanup_runs_job_id_idx on storage_cleanup_runs (job_id);
create index storage_cleanup_runs_ran_at_idx on storage_cleanup_runs (ran_at desc);

alter table storage_cleanup_runs enable row level security;
