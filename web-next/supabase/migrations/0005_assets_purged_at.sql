-- Tier 3 (storage-retention-policy.md) deletes a superseded job's media
-- bytes but explicitly keeps its `assets` row as history. Without a way to
-- mark that, the row's `storage_key` silently points at nothing — any UI
-- or API built against `assets` would offer a download link that 404s,
-- with no way to tell "still real" apart from "historical record only."
-- This column closes that gap.

alter table assets add column purged_at timestamptz;

-- Fast lookup of "this job's assets that are still real" (tier 3's own
-- query) and "not yet purged" scans generally.
create index assets_purged_at_idx on assets (job_id) where purged_at is null;
