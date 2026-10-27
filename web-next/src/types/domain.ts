// Shared domain types for the reel-pipeline Next.js app.
// Mirrors the data model implied by Section 8 of requirement.md (jobs, stages,
// tools, assets, click events, subscribers) — exact Supabase schema is a
// Phase 1/2 decision to finalize against AUDIT.md, not invented here.

export type JobStatus =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'done'
  | 'failed'
  | 'interrupted';

export type StageName =
  | 'grab'
  | 'describe'
  | 'script'
  | 'match'
  | 'qa'
  | 'trial'
  | 'assemble'
  | 'upload';

export interface StageProgress {
  stage: StageName;
  status: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  skippedReason?: string;
}

export interface Job {
  id: string;
  toolSlug: string;
  toolName: string;
  url: string;
  stages: StageName[];
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  progress: StageProgress[];
  error?: string;
}

export type PriceTier = 'free' | 'paid';

export interface Tool {
  slug: string;
  name: string;
  url: string;
  priceTier: PriceTier;
  checkoutUrl?: string;
  commentKeyword?: string;
  hasReelKit: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AssetKind = 'extract' | 'clip' | 'rough_cut' | 'lead_magnet' | 'hook' | 'other';

export interface AssetRecord {
  id: string;
  toolSlug: string;
  jobId?: string;
  kind: AssetKind;
  storageKey: string;
  filename: string;
  contentType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  sizeBytes?: number;
  createdAt: string;
}

export interface Shot {
  index: number;
  heading: string;
  clipFile?: string;
  durationSeconds: number;
  qa?: 'pass' | 'fail' | 'missing';
  qaReasons?: string[];
  matchScore?: number;
}

export interface ScriptDocument {
  toolSlug: string;
  scriptText: string;
  shots: Shot[];
  updatedAt: string;
}

export interface KeywordRecord {
  keyword: string;
  toolSlug: string;
  toolName: string;
  destination: string;
  clickCount: number;
  duplicate: boolean;
}

export interface ClickEvent {
  id: string;
  keyword: string;
  // Nullable: a click is logged even when no tool owns the keyword
  // (matches app.py's /go/{keyword} handler — tool_id can be "").
  toolSlug: string | null;
  redirectTarget: string;
  occurredAt: string;
}

export interface SubscriberRecord {
  id: string;
  email: string;
  name?: string;
  // Nullable: preserved if the owning tool is later deleted (see the
  // migration's ON DELETE SET NULL rationale in 0002_click_events_subscribers.sql).
  toolSlug: string | null;
  keyword: string | null;
  subscribedAt: string;
}
