import { z } from 'zod';

// Mirrors web-next's WorkerTaskResult (src/lib/workerClient.ts) exactly —
// this is the contract both sides of the HTTP boundary agree on. Keep
// these in sync by hand for now; there's no shared package between the
// two projects yet (they're separate deployables per Section 2.1).
export interface WorkerTaskResult {
  status: 'ok' | 'error';
  message?: string;
  data?: Record<string, unknown>;
}

// Matches exactly what web-next's src/inngest/stages/grab.ts sends in
// its callWorkerTask('capture_site', { ... }) call.
export const captureSiteRequestSchema = z.object({
  jobId: z.string().min(1),
  toolSlug: z.string().min(1),
  url: z.string().url(),
  headed: z.boolean().optional().default(false),
  storagePrefix: z.string().min(1),
});

export type CaptureSiteRequest = z.infer<typeof captureSiteRequestSchema>;

// Matches exactly what web-next's src/inngest/stages/describe.ts sends in
// its callWorkerTask('describe_clips', { ... }) call.
export const describeClipsRequestSchema = z.object({
  jobId: z.string().min(1),
  toolSlug: z.string().min(1),
  grabStoragePrefix: z.string().min(1),
  storagePrefix: z.string().min(1),
});

export type DescribeClipsRequest = z.infer<typeof describeClipsRequestSchema>;

// PIPE-03's documented catalog entry shape: caption, 2-5 tags, has_ui
// flag, clip_type.
export interface ClipCatalogEntry {
  caption: string;
  tags: string[];
  has_ui: boolean;
  clip_type: 'ui' | 'example_output';
}

export type ClipCatalog = Record<string, ClipCatalogEntry>; // keyed by clip filename

// Matches exactly what web-next's src/inngest/stages/qa.ts sends in its
// callWorkerTask('run_qa', { ... }) call.
export const runQaRequestSchema = z.object({
  jobId: z.string().min(1),
  toolSlug: z.string().min(1),
  grabStoragePrefix: z.string().min(1),
  storagePrefix: z.string().min(1),
});

export type RunQaRequest = z.infer<typeof runQaRequestSchema>;

// qa.py's qa_report.json row shape (PIPE-06).
export interface QaReportEntry {
  file: string;
  seconds: number | null;
  size: string | null;
  sharpness: number | null;
  motion: number | null;
  ok: boolean;
  issues: string[];
}

// Matches exactly what web-next's src/inngest/stages/assemble.ts sends
// in its callWorkerTask('assemble_rough_cut', { ... }) call.
export const assembleRoughCutRequestSchema = z.object({
  jobId: z.string().min(1),
  toolSlug: z.string().min(1),
  toolName: z.string().min(1),
  matchStoragePrefix: z.string().min(1),
  storagePrefix: z.string().min(1),
  placeholders: z.boolean().optional().default(true),
});

export type AssembleRoughCutRequest = z.infer<typeof assembleRoughCutRequestSchema>;

// Matches exactly what web-next's src/inngest/stages/script.ts sends in
// its callWorkerTask('fetch_site_text', { ... }) call — PIPE-04's
// fetch_site_text() prerequisite for script generation.
export const fetchSiteTextRequestSchema = z.object({
  jobId: z.string().min(1),
  toolSlug: z.string().min(1),
  url: z.string().url(),
  storagePrefix: z.string().min(1),
});

export type FetchSiteTextRequest = z.infer<typeof fetchSiteTextRequestSchema>;

// Matches exactly what web-next's src/inngest/stages/match.ts sends in
// its callWorkerTask('record_missing_shot_clips', { ... }) call — the
// grabber.py fallback for website-sourced shots Rules 1/1b/2 couldn't
// match to an existing clip (PIPE-05).
export const recordMissingShotClipsRequestSchema = z.object({
  jobId: z.string().min(1),
  toolSlug: z.string().min(1),
  url: z.string().url(),
  storagePrefix: z.string().min(1),
  headed: z.boolean().optional().default(false),
  shots: z.array(
    z.object({
      shot: z.number().int(),
      visualNeeded: z.string(),
      scriptLine: z.string(),
      durationSeconds: z.number(),
    })
  ),
});

export type RecordMissingShotClipsRequest = z.infer<typeof recordMissingShotClipsRequestSchema>;

// No reel-pipeline stage calls this yet (see server.ts's comment on
// normalize_media / extract_media) — the contract is a plain list of
// storage keys to normalize, each independent of the others, rather
// than shaped around any particular stage's storagePrefix convention.
export const normalizeMediaRequestSchema = z.object({
  jobId: z.string().min(1),
  toolSlug: z.string().min(1),
  keys: z.array(z.string().min(1)).min(1),
});

export type NormalizeMediaRequest = z.infer<typeof normalizeMediaRequestSchema>;

// Matches web-next's src/app/api/extract-assets/route.ts job (EXTRACT-*
// numbering, a separate product from the 8-stage reel pipeline) — see
// extractMedia.ts's file-level comment for exactly what this covers.
export const extractMediaRequestSchema = z.object({
  jobId: z.string().min(1),
  toolSlug: z.string().min(1),
  url: z.string().url(),
  storagePrefix: z.string().min(1),
  headed: z.boolean().optional().default(false),
});

export type ExtractMediaRequest = z.infer<typeof extractMediaRequestSchema>;

