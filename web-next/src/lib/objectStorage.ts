import { getSupabaseServerClient } from './supabase';

// Supabase Storage implementation of the private-bucket operations the
// retention sweeps and the pipeline stage executors (src/inngest/stages/)
// need. object-storage-layout.md leaves the storage provider open
// (Supabase Storage vs. S3-compatible) — this file is deliberately the
// only place that talks to the provider's actual API, so swapping
// providers later means rewriting this file, not every caller.
const PRIVATE_BUCKET =
  process.env.OBJECT_STORAGE_PRIVATE_BUCKET || process.env.OBJECT_STORAGE_BUCKET || '';

// Supabase Storage's list() returns only the immediate children of a
// folder, unlike S3's ListObjectsV2 (which is flat for a given Prefix) —
// so listing everything under a job's prefix (which has nested stage
// subfolders: extract/videos_gifs/, grab/clips/, etc.) means walking
// folders ourselves. A folder entry has `id: null`; a real object does
// not. This is the one place an S3-compatible rewrite would simplify
// rather than complicate.
async function listAllKeysRecursive(bucket: string, prefix: string): Promise<string[]> {
  const supabase = getSupabaseServerClient();
  const keys: string[] = [];

  async function walk(path: string) {
    const { data, error } = await supabase.storage.from(bucket).list(path, { limit: 1000 });
    if (error) throw error;

    for (const entry of data ?? []) {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.id === null) {
        await walk(entryPath);
      } else {
        keys.push(entryPath);
      }
    }
  }

  await walk(prefix.replace(/\/$/, ''));
  return keys;
}

// Lists then deletes every object under `prefix` in the private bucket.
// Deleting a key that's already gone is a success, not an error (Supabase
// Storage's remove() doesn't error on missing keys) — required for this
// to be safely re-runnable, per storage-retention-policy.md's idempotent-
// delete rule. Returns the keys it deleted, for the caller's audit log.
export async function deleteAllUnderPrefix(prefix: string): Promise<string[]> {
  if (!PRIVATE_BUCKET) {
    throw new Error('OBJECT_STORAGE_PRIVATE_BUCKET (or OBJECT_STORAGE_BUCKET) is not configured');
  }

  const supabase = getSupabaseServerClient();
  const keys = await listAllKeysRecursive(PRIVATE_BUCKET, prefix);
  if (keys.length === 0) return [];

  const { error } = await supabase.storage.from(PRIVATE_BUCKET).remove(keys);
  if (error) throw error;

  return keys;
}

// Deletes exactly the given keys — unlike deleteAllUnderPrefix, this does
// no listing and takes no prefix. Tier 3 needs this precision: a
// superseded job's folder has both media (to delete) and manifests/
// reports (tier 4 — kept indefinitely) side by side, so prefix-deleting
// the whole job folder would violate tier 4. Same idempotent-delete
// guarantee as deleteAllUnderPrefix — an already-gone key is a no-op.
export async function deleteKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (!PRIVATE_BUCKET) {
    throw new Error('OBJECT_STORAGE_PRIVATE_BUCKET (or OBJECT_STORAGE_BUCKET) is not configured');
  }

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.storage.from(PRIVATE_BUCKET).remove(keys);
  if (error) throw error;
}

// Finds tmp objects older than `cutoffIso`, across every tool/job. Unlike
// the other sweeps, tier 1 has no DB table to query for candidates — tmp
// files are deliberately not tracked in `assets` (storage-retention-
// policy.md: "N/A, tmp isn't tracked in assets") — so this has to walk the
// storage tree itself: tools/<slug>/jobs/<id>/tmp/, fixed-depth, rather
// than a full recursive walk of everything (which would also descend into
// extract/, grab/, etc. for no reason).
//
// Scaling note: this does one list() call per tool and per job to find
// tmp/ folders, which is O(tools x jobs) regardless of how much tmp data
// actually exists. Fine at the scale this product runs at today; if the
// job table grows very large, this is the first thing to revisit (e.g. by
// tracking tmp writes in a DB table after all, trading tier 1's current
// simplicity for tier 2/3's query-driven approach). Not built now because
// nothing today indicates it's needed.
export async function listStaleTmpKeys(
  cutoffIso: string,
  maxKeys = 500
): Promise<string[]> {
  if (!PRIVATE_BUCKET) {
    throw new Error('OBJECT_STORAGE_PRIVATE_BUCKET (or OBJECT_STORAGE_BUCKET) is not configured');
  }

  const supabase = getSupabaseServerClient();
  const cutoffMs = new Date(cutoffIso).getTime();
  const staleKeys: string[] = [];

  async function walkTmp(path: string) {
    if (staleKeys.length >= maxKeys) return;
    const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).list(path, { limit: 1000 });
    if (error) throw error;

    for (const entry of data ?? []) {
      if (staleKeys.length >= maxKeys) return;
      const entryPath = `${path}/${entry.name}`;
      if (entry.id === null) {
        await walkTmp(entryPath);
      } else if (!entry.updated_at || new Date(entry.updated_at).getTime() < cutoffMs) {
        // No updated_at at all is treated as stale rather than skipped —
        // an object this sweep can't date is not one we want to keep
        // indefinitely by default.
        staleKeys.push(entryPath);
      }
    }
  }

  // Must match deleteAllUnderPrefix's convention exactly (object-storage-
  // layout.md: `private/tools/<slug>/jobs/<id>/...`) — this previously
  // started from bare 'tools', which would have made tier 1 a silent,
  // permanent no-op in production (every real key lives under
  // `private/tools/...`, so a walk starting at 'tools' would find nothing
  // for every actual object). Caught by writing cleanupTmpStorage.test.ts.
  const { data: toolFolders, error: toolsError } = await supabase.storage
    .from(PRIVATE_BUCKET)
    .list('private/tools', { limit: 1000 });
  if (toolsError) throw toolsError;

  for (const toolFolder of toolFolders ?? []) {
    if (staleKeys.length >= maxKeys) break;
    if (toolFolder.id !== null) continue; // not a folder — shouldn't happen at this depth, skip defensively

    const { data: jobFolders, error: jobsError } = await supabase.storage
      .from(PRIVATE_BUCKET)
      .list(`private/tools/${toolFolder.name}/jobs`, { limit: 1000 });
    if (jobsError) throw jobsError;

    for (const jobFolder of jobFolders ?? []) {
      if (staleKeys.length >= maxKeys) break;
      if (jobFolder.id !== null) continue;

      await walkTmp(`private/tools/${toolFolder.name}/jobs/${jobFolder.name}/tmp`);
    }
  }

  return staleKeys;
}

export interface StorageObjectInfo {
  key: string;
  updatedAt: string | null;
}

// Lists objects under every job's own folder (private/tools/<slug>/
// jobs/<id>/...), excluding that job's tmp/ subfolder (tier 1 owns that)
// — for tier 0's orphan reconciliation. Deliberately mirrors tier 1's
// tool-by-tool, job-by-job enumeration instead of one blanket recursive
// walk from private/tools: a blanket walk would also descend into
// private/tools/<slug>/manual/** (tool-scoped manual uploads, tier 7 —
// never swept), which this function must never touch. Scoping the walk
// to only ever enter a job's own folder keeps that true by construction,
// not by a runtime check that could be wrong.
export async function listJobObjectsExcludingTmp(maxKeys = 500): Promise<StorageObjectInfo[]> {
  if (!PRIVATE_BUCKET) {
    throw new Error('OBJECT_STORAGE_PRIVATE_BUCKET (or OBJECT_STORAGE_BUCKET) is not configured');
  }

  const supabase = getSupabaseServerClient();
  const found: StorageObjectInfo[] = [];

  async function walk(path: string) {
    if (found.length >= maxKeys) return;
    const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).list(path, { limit: 1000 });
    if (error) throw error;

    for (const entry of data ?? []) {
      if (found.length >= maxKeys) return;
      const entryPath = `${path}/${entry.name}`;
      if (entry.id === null) {
        if (entry.name === 'tmp') continue; // tier 1's territory, not ours
        await walk(entryPath);
      } else {
        found.push({ key: entryPath, updatedAt: entry.updated_at ?? null });
      }
    }
  }

  const { data: toolFolders, error: toolsError } = await supabase.storage
    .from(PRIVATE_BUCKET)
    .list('private/tools', { limit: 1000 });
  if (toolsError) throw toolsError;

  for (const toolFolder of toolFolders ?? []) {
    if (found.length >= maxKeys) break;
    if (toolFolder.id !== null) continue;

    const { data: jobFolders, error: jobsError } = await supabase.storage
      .from(PRIVATE_BUCKET)
      .list(`private/tools/${toolFolder.name}/jobs`, { limit: 1000 });
    if (jobsError) throw jobsError;

    for (const jobFolder of jobFolders ?? []) {
      if (found.length >= maxKeys) break;
      if (jobFolder.id !== null) continue;

      await walk(`private/tools/${toolFolder.name}/jobs/${jobFolder.name}`);
    }
  }

  return found;
}

// Returns null if the object doesn't exist, rather than throwing — match.ts
// (src/inngest/stages/match.ts) relies on this to treat "no script.txt yet"
// / "no existing clip_catalog.json yet" as a normal, expected state, not
// an error. Confirmed via the real supabase-js types (download() returns
// `Blob | null`) rather than assumed — same check done for the worker's
// equivalent helper (worker/src/lib/storage.ts).
export async function downloadObjectText(key: string): Promise<string | null> {
  if (!PRIVATE_BUCKET) {
    throw new Error('OBJECT_STORAGE_PRIVATE_BUCKET (or OBJECT_STORAGE_BUCKET) is not configured');
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).download(key);
  if (error) {
    if ('status' in error && (error as { status?: number }).status === 404) return null;
    const message = (error as { message?: string }).message || '';
    if (/not.?found/i.test(message)) return null;
    throw error;
  }
  if (!data) return null;
  return await data.text();
}

// Upsert: true — every stage write in this pipeline targets a
// deterministic, job-scoped key (object-storage-layout.md), so a retry
// overwriting the same key is correct idempotent behavior, not a
// collision (same rule the worker's uploadObject follows).
export async function uploadObjectText(key: string, body: string, contentType: string): Promise<void> {
  if (!PRIVATE_BUCKET) {
    throw new Error('OBJECT_STORAGE_PRIVATE_BUCKET (or OBJECT_STORAGE_BUCKET) is not configured');
  }

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(key, body, { contentType, upsert: true });
  if (error) throw error;
}

export async function uploadObjectJson(key: string, value: unknown): Promise<void> {
  await uploadObjectText(key, JSON.stringify(value, null, 2), 'application/json');
}

export async function objectExists(key: string): Promise<boolean> {
  if (!PRIVATE_BUCKET) {
    throw new Error('OBJECT_STORAGE_PRIVATE_BUCKET (or OBJECT_STORAGE_BUCKET) is not configured');
  }

  const supabase = getSupabaseServerClient();
  const lastSlash = key.lastIndexOf('/');
  const folder = lastSlash === -1 ? '' : key.slice(0, lastSlash);
  const filename = lastSlash === -1 ? key : key.slice(lastSlash + 1);

  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).list(folder, {
    limit: 1000,
    search: filename,
  });
  if (error) throw error;
  return (data ?? []).some((entry) => entry.name === filename && entry.id !== null);
}
