// PIPE-01's stage order and dependency graph, as pure data/logic —
// deliberately kept free of Inngest, Supabase, and the worker client so
// it's directly unit-testable and is the one place this graph is defined
// (the orchestrator reads it, never re-encodes it).
//
// Order matches requirement.md's documented default:
// grab -> describe -> script -> match -> qa -> trial -> assemble -> upload.
// This is already a valid topological order for the dependency graph
// below — verified by inspection, not just assumed: describe depends only
// on grab (which precedes it); match depends on grab and script (both
// precede it); qa/trial/assemble depend only on match (precedes them);
// upload depends only on assemble (precedes it).
export const STAGE_ORDER = [
  'grab',
  'describe',
  'script',
  'match',
  'qa',
  'trial',
  'assemble',
  'upload',
] as const;

export type Stage = (typeof STAGE_ORDER)[number];

// Exactly PIPE-01's documented dependencies: "describe requires grab;
// match requires grab and script; qa and trial require match; assemble
// requires match; upload requires assemble." grab and script have no
// listed prerequisite.
export const STAGE_DEPENDENCIES: Record<Stage, Stage[]> = {
  grab: [],
  describe: ['grab'],
  script: [],
  match: ['grab', 'script'],
  qa: ['match'],
  trial: ['match'],
  assemble: ['match'],
  upload: ['assemble'],
};

export type StageOutcome = 'done' | 'failed' | 'skipped';

// Returns the first prerequisite of `stage` that hasn't completed
// ('done') in `outcomes`, or null if every prerequisite is satisfied.
// `outcomes` only needs entries for stages already processed earlier in
// STAGE_ORDER — a prerequisite later in the order is impossible per the
// graph above, so an absent entry (undefined) correctly reads as "not
// done."
export function unmetPrerequisite(
  stage: Stage,
  outcomes: Partial<Record<Stage, StageOutcome>>
): Stage | null {
  for (const dep of STAGE_DEPENDENCIES[stage]) {
    if (outcomes[dep] !== 'done') return dep;
  }
  return null;
}
