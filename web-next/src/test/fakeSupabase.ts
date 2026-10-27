import { randomUUID } from 'crypto';

// A faithful in-memory substitute for the exact subset of the
// supabase-js query-builder and Storage API that the three cleanup
// sweeps (and src/lib/objectStorage.ts) actually call. This is the real
// integration seam: tests exercise the real sweep handlers and the real
// src/lib/objectStorage.ts against this fake, swapped in only at
// getSupabaseServerClient() (see each test's vi.mock('@/lib/supabase', ...)).
//
// Honest limitation: there is no Docker/local Postgres available in this
// environment (checked — no psql, no docker), so this cannot be a true
// end-to-end test against a running Supabase project. This fake
// reproduces the documented behavior of the specific operators used
// (eq/in/lt/is/not/order/limit/delete/update/insert, and Storage's
// list()/remove() folder semantics) — it is not a general-purpose
// PostgREST or Storage emulator.

type Row = Record<string, unknown>;
type Table = Row[];

export interface FakeDb {
  jobs: Table;
  assets: Table;
  job_stages: Table;
  storage_cleanup_runs: Table;
  tools: Table;
}

export function createFakeDb(): FakeDb {
  return { jobs: [], assets: [], job_stages: [], storage_cleanup_runs: [], tools: [] };
}

type Filter =
  | { type: 'eq'; col: string; val: unknown }
  | { type: 'in'; col: string; val: unknown[] }
  | { type: 'lt'; col: string; val: unknown }
  | { type: 'is'; col: string; val: unknown }
  | { type: 'not-is'; col: string; val: unknown };

function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

function matchesFilter(row: Row, f: Filter): boolean {
  switch (f.type) {
    case 'eq':
      return row[f.col] === f.val;
    case 'in':
      return f.val.includes(row[f.col]);
    case 'lt':
      return (row[f.col] as string) < (f.val as string);
    case 'is':
      return isNullish(f.val) ? isNullish(row[f.col]) : row[f.col] === f.val;
    case 'not-is':
      return isNullish(f.val) ? !isNullish(row[f.col]) : row[f.col] !== f.val;
  }
}

class FakeQueryBuilder implements PromiseLike<{ data: Row[] | null; error: Error | null }> {
  private filters: Filter[] = [];
  private orders: { col: string; ascending: boolean }[] = [];
  private limitN: number | null = null;
  private op: 'select' | 'delete' | 'update' | 'insert' | 'upsert' = 'select';
  private updateObj: Row | null = null;
  private insertRows: Row[] = [];
  private onConflictCols: string[] = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;

  constructor(private table: Table) {}

  select(_cols?: string) {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ type: 'eq', col, val });
    return this;
  }
  in(col: string, val: unknown[]) {
    this.filters.push({ type: 'in', col, val });
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push({ type: 'lt', col, val });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ type: 'is', col, val });
    return this;
  }
  not(col: string, innerOp: string, val: unknown) {
    if (innerOp !== 'is') {
      throw new Error(`fakeSupabase: not(${col}, ${innerOp}, ...) not implemented`);
    }
    this.filters.push({ type: 'not-is', col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, ascending: opts?.ascending ?? true });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  update(obj: Row) {
    this.op = 'update';
    this.updateObj = obj;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert';
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
    this.op = 'upsert';
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    this.onConflictCols = opts?.onConflict ? opts.onConflict.split(',').map((s) => s.trim()) : [];
    return this;
  }

  private matched(): Row[] {
    return this.table.filter((row) => this.filters.every((f) => matchesFilter(row, f)));
  }

  private execute(): { data: Row[] | null; error: Error | null } {
    if (this.op === 'insert') {
      const inserted = this.insertRows.map((r) => ({ id: randomUUID(), ran_at: new Date().toISOString(), ...r }));
      this.table.push(...inserted);
      return { data: inserted, error: null };
    }

    if (this.op === 'upsert') {
      const results: Row[] = [];
      for (const row of this.insertRows) {
        const existing =
          this.onConflictCols.length > 0
            ? this.table.find((r) => this.onConflictCols.every((c) => r[c] === row[c]))
            : undefined;
        if (existing) {
          Object.assign(existing, row);
          results.push(existing);
        } else {
          const inserted = { id: randomUUID(), ...row };
          this.table.push(inserted);
          results.push(inserted);
        }
      }
      return { data: results, error: null };
    }

    if (this.op === 'delete') {
      const toDelete = this.matched();
      for (const row of toDelete) {
        const idx = this.table.indexOf(row);
        if (idx !== -1) this.table.splice(idx, 1);
      }
      return { data: null, error: null };
    }

    if (this.op === 'update') {
      const toUpdate = this.matched();
      for (const row of toUpdate) Object.assign(row, this.updateObj);
      return { data: null, error: null };
    }

    // select
    let rows = this.matched().map((r) => ({ ...r }));
    if (this.orders.length > 0) {
      // A single comparator checking each .order() criterion in the order
      // they were called, falling through to the next on a tie — matches
      // PostgREST's "first .order() is primary, later ones are
      // tiebreakers" semantics. (An earlier version of this applied each
      // criterion as a separate sequential sort, which — even though
      // Array.sort is stable — makes the LAST criterion dominate, not the
      // first, since a later stable sort only preserves relative order
      // among elements the later sort treats as equal. That's backwards
      // from what cleanupSupersededJobMedia.ts relies on: tool_slug as
      // the primary grouping key, finished_at as the secondary one.)
      rows = [...rows].sort((a, b) => {
        for (const { col, ascending } of this.orders) {
          const av = a[col] as string;
          const bv = b[col] as string;
          if (av === bv) continue;
          const cmp = av < bv ? -1 : 1;
          return ascending ? cmp : -cmp;
        }
        return 0;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    if (this.rangeFrom !== null) rows = rows.slice(this.rangeFrom, (this.rangeTo ?? rows.length) + 1);
    return { data: rows, error: null };
  }

  then<TResult1, TResult2 = never>(
    onFulfilled?: ((value: { data: Row[] | null; error: Error | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }
}

// --- Storage fake -----------------------------------------------------

interface StoredObject {
  id: string;
  updatedAt: string | null;
  content?: string;
}

export type FakeBucket = Map<string, StoredObject>;

function listFolder(bucket: FakeBucket, path: string, limit?: number) {
  const prefix = path ? `${path}/` : '';
  const seenFolders = new Set<string>();
  const entries: { name: string; id: string | null; updated_at: string | null }[] = [];

  for (const [key, meta] of bucket.entries()) {
    if (!key.startsWith(prefix)) continue;
    const remainder = key.slice(prefix.length);
    if (!remainder) continue;
    const slashIdx = remainder.indexOf('/');
    if (slashIdx === -1) {
      entries.push({ name: remainder, id: meta.id, updated_at: meta.updatedAt });
    } else {
      const folderName = remainder.slice(0, slashIdx);
      if (!seenFolders.has(folderName)) {
        seenFolders.add(folderName);
        entries.push({ name: folderName, id: null, updated_at: null });
      }
    }
  }

  return limit ? entries.slice(0, limit) : entries;
}

export function createFakeStorageBucket(
  seed: Record<string, { updatedAt: string | null; content?: string }> = {}
): FakeBucket {
  const bucket: FakeBucket = new Map();
  for (const [key, meta] of Object.entries(seed)) {
    bucket.set(key, { id: randomUUID(), updatedAt: meta.updatedAt, content: meta.content });
  }
  return bucket;
}

// For tests that seed/add a single object after the bucket already
// exists (e.g. simulating "a prior stage already wrote this file"),
// rather than only at createFakeStorageBucket's construction time.
export function setFakeBucketObject(
  bucket: FakeBucket,
  key: string,
  meta: { updatedAt: string | null; content?: string }
): void {
  bucket.set(key, { id: randomUUID(), updatedAt: meta.updatedAt, content: meta.content });
}

export function createFakeSupabaseClient(db: FakeDb, buckets: Record<string, FakeBucket>) {
  return {
    from(table: keyof FakeDb) {
      return new FakeQueryBuilder(db[table]);
    },
    storage: {
      from(bucketName: string) {
        const bucket = buckets[bucketName] ?? (buckets[bucketName] = new Map());
        return {
          list(path: string, opts?: { limit?: number; search?: string }) {
            let entries = listFolder(bucket, path, opts?.limit);
            if (opts?.search) entries = entries.filter((e) => e.name === opts.search);
            return Promise.resolve({ data: entries, error: null });
          },
          remove(keys: string[]) {
            for (const k of keys) bucket.delete(k);
            return Promise.resolve({ error: null });
          },
          // Real Supabase Storage returns a Blob; match.ts's caller only
          // ever calls .text() on it, so this fake implements just that.
          download(key: string) {
            const entry = bucket.get(key);
            if (!entry) {
              return Promise.resolve({ data: null, error: { message: 'Object not found', status: 404 } });
            }
            return Promise.resolve({ data: { text: async () => entry.content ?? '' }, error: null });
          },
          upload(key: string, body: string, opts?: { contentType?: string; upsert?: boolean }) {
            bucket.set(key, { id: randomUUID(), updatedAt: new Date().toISOString(), content: body });
            void opts;
            return Promise.resolve({ data: { path: key }, error: null });
          },
        };
      },
    },
  };
}
