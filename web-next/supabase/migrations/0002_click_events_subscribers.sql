-- click_events and subscribers (requirement.md MC-03/MC-04), linked to tools.
-- Grounded in the actual handler bodies (app.py:1227-1287), not guessed:
--   - clicks.csv columns: clicked_at, keyword, tool_id, redirect_to.
--     tool_id can legitimately be "" when no tool owns the keyword — the
--     source still logs the click (it's a real hit worth counting, just
--     unattributed).
--   - subscribers.csv columns: subscribed_at, email, name, keyword, tool_id.
--     Dedup is on lower-cased email GLOBALLY (across all tools), not per
--     tool — `known = {r["email"].lower() for r in read_csv_rows(...)}`
--     has no tool_id filter. tool_id is always resolved before insert (the
--     handler 404s otherwise), so it's NOT NULL here, unlike click_events.
--
-- Open question for the project owner: the source's csv_safe() escaping
-- guards against spreadsheet-formula injection (MC-04) when the CSV file
-- is opened directly in Excel/Sheets. That risk doesn't apply to storing
-- plain text in Postgres — but if/when these tables grow a CSV export
-- endpoint, that endpoint must re-apply the same escaping on the way out.
-- Not designed here since no export endpoint exists yet.

-- ---------------------------------------------------------------------------
-- click_events
-- ---------------------------------------------------------------------------

create table click_events (
  id             uuid primary key default gen_random_uuid(),
  -- Nullable + ON DELETE SET NULL for two reasons: (1) the source logs a
  -- click even when no tool owns the keyword (tool_id = ""), and (2) a
  -- click shouldn't be lost if the tool is later deleted.
  tool_slug      text references tools (slug) on delete set null,
  keyword        text not null,                 -- normalized keyword, or the raw (truncated) input if normalization emptied it — matches `kw or keyword[:30]`
  redirect_target text not null,                -- the checkout URL, the /out/<tool>/lead_magnet.html path, or /library
  occurred_at    timestamptz not null default now()
);

create index click_events_tool_slug_idx on click_events (tool_slug);
create index click_events_keyword_idx on click_events (keyword);
create index click_events_occurred_at_idx on click_events (occurred_at desc);

-- ---------------------------------------------------------------------------
-- subscribers
-- ---------------------------------------------------------------------------

create table subscribers (
  id            uuid primary key default gen_random_uuid(),
  -- Nullable + ON DELETE SET NULL to preserve the lead record even if the
  -- tool is later deleted — matches jobs.tool_slug's rationale, not the
  -- source's NOT NULL-in-practice behavior (the source 404s before insert
  -- if tool_id can't be resolved, but that's app-layer validation, not a
  -- reason to lose a captured lead on a later, unrelated tool deletion).
  tool_slug     text references tools (slug) on delete set null,
  email         text not null,
  name          text,                            -- matches the source's 100-char truncation + whitespace collapse — enforce in the app layer, not here
  keyword       text,                             -- nullable: the source allows resolving straight from tool_id with no keyword
  subscribed_at timestamptz not null default now()
);

-- Global de-dup on lower-cased email, matching the source exactly (MC-04:
-- "Duplicate emails are reported but not re-added" — checked across ALL
-- tools, not per-tool).
create unique index subscribers_email_lower_unique on subscribers (lower(email));

create index subscribers_tool_slug_idx on subscribers (tool_slug);
create index subscribers_keyword_idx on subscribers (keyword);

alter table click_events enable row level security;
alter table subscribers enable row level security;
