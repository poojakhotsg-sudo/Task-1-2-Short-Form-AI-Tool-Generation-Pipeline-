// Mirrors the worker's ClipCatalog type (worker/src/types.ts) exactly —
// describe_clips (worker) writes this shape to clip_catalog.json; match
// (here) reads it. No shared package between the two projects yet (same
// note as web-next's workerClient.ts).
export interface ClipCatalogEntry {
  caption: string;
  tags: string[];
  has_ui: boolean;
  clip_type: 'ui' | 'example_output';
}

export type ClipCatalog = Record<string, ClipCatalogEntry>;

export interface MatchedShot {
  shot: number;
  label: string;
  scriptLine: string;
  source: 'website' | 'trial';
  file: string | null;
  status: 'ok' | 'missing' | 'needs_trial';
  matchScore: number;
  matchType: 'script_specified' | 'per_shot_clip' | 'vision_score' | 'mobile_recording' | null;
  // PIPE-09's assemble stage trims each clip to this (matcher.py's
  // build_shots() already computes it from script.txt/shot_list.json —
  // this was being silently dropped when match_result.json was written,
  // which would have made assemble unable to know each shot's target
  // duration at all. Fixed as a direct prerequisite for assemble_rough_cut.
  durationSeconds: number;
  error?: string;
}

export interface MatchResult {
  shots: MatchedShot[];
  matchedCount: number;
  clipsAvailable: number;
}
