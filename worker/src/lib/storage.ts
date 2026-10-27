import { createClient } from '@supabase/supabase-js';

// Mirrors web-next's src/lib/objectStorage.ts naming exactly
// (OBJECT_STORAGE_PRIVATE_BUCKET, falling back to OBJECT_STORAGE_BUCKET)
// so both projects agree on which bucket "private" means without a
// shared config package.
//
// OPEN QUESTION, flagged rather than silently resolved: which credential
// the worker authenticates storage uploads with isn't decided yet.
// Migration 0003 (web-next/supabase/migrations/0003_worker_role_policies.sql)
// gives the worker a scoped Postgres role specifically so it doesn't need
// the service-role key for *table* access — but Supabase Storage access
// control is a separate mechanism (storage.objects RLS / bucket
// policies, not the same policies as regular tables), and that hasn't
// been designed. For now this reads SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY, which works but reintroduces exactly the
// "don't hand the worker the service-role key" problem migration 0003
// solved for Postgres. Revisit once Storage-specific scoping is designed
// — not done here because that's a distinct piece of work (Supabase
// Storage policies use different syntax than the table RLS in migration
// 0003), not an oversight.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PRIVATE_BUCKET =
  process.env.OBJECT_STORAGE_PRIVATE_BUCKET || process.env.OBJECT_STORAGE_BUCKET || '';

let client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (client) return client;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured');
  }
  client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  return client;
}

export interface UploadInput {
  key: string;
  body: Buffer | string;
  contentType: string;
}

// Uploads with upsert: true — every stage write in this pipeline is to a
// deterministic, job-scoped key (object-storage-layout.md), so a retry
// overwriting the same key is the correct idempotent behavior, not a
// collision to guard against.
export async function uploadObject({ key, body, contentType }: UploadInput): Promise<void> {
  if (!PRIVATE_BUCKET) {
    throw new Error('OBJECT_STORAGE_PRIVATE_BUCKET (or OBJECT_STORAGE_BUCKET) is not configured');
  }

  const supabase = getClient();
  const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(key, body, {
    contentType,
    upsert: true,
  });
  if (error) throw error;
}

// Returns null if the object doesn't exist, rather than throwing — callers
// that treat "no existing catalog yet" as a normal first-run case (not an
// error) rely on this.
export async function downloadObject(key: string): Promise<Buffer | null> {
  if (!PRIVATE_BUCKET) {
    throw new Error('OBJECT_STORAGE_PRIVATE_BUCKET (or OBJECT_STORAGE_BUCKET) is not configured');
  }

  const supabase = getClient();
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).download(key);
  if (error) {
    // Supabase Storage's JS client reports a missing object as an error
    // (no dedicated "not found" return value) — treat it as "doesn't
    // exist" rather than a real failure, since every call site needs
    // exactly that distinction.
    if ('status' in error && (error as { status?: number }).status === 404) return null;
    const message = (error as { message?: string }).message || '';
    if (/not.?found/i.test(message)) return null;
    throw error;
  }
  if (!data) return null;
  return Buffer.from(await data.arrayBuffer());
}

export interface StorageEntry {
  key: string;
}

// Lists files (not subfolders) directly under `prefix` — matches
// web-next's objectStorage.ts folder-vs-file convention (id: null means
// folder) but doesn't need the recursive walk that file uses, since
// clip files live flat under grabStoragePrefix + 'clips/' with no
// further nesting.
export async function listObjectsUnderPrefix(prefix: string): Promise<StorageEntry[]> {
  if (!PRIVATE_BUCKET) {
    throw new Error('OBJECT_STORAGE_PRIVATE_BUCKET (or OBJECT_STORAGE_BUCKET) is not configured');
  }

  const supabase = getClient();
  const path = prefix.replace(/\/$/, '');
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).list(path, { limit: 1000 });
  if (error) throw error;

  return (data ?? [])
    .filter((entry) => entry.id !== null) // files only, skip subfolders
    .map((entry) => ({ key: `${path}/${entry.name}` }));
}
