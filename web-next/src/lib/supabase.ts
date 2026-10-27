import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Server-only Supabase client. Never import this from a Client Component —
// SUPABASE_SERVICE_ROLE_KEY must never reach the browser bundle (Section 9).
// Table/column names are placeholders pending the Phase 1 schema agreement
// (Section 12, Phase 1) — see AUDIT.md for the current data shapes this
// needs to support (data/tools.json, jobs.db, clicks.csv, subscribers.csv).

let client: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabaseServerClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local'
    );
  }

  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
  return client;
}
