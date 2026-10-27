import { Inngest } from 'inngest';
import type { StageName } from '@/types/domain';

// Event emission only in this phase. Durable step functions, retries, and
// stage-dependency logic are Phase 3 (Inngest Orchestration) — see
// requirement.md Section 12. Events carry job IDs, stage names, and safe
// options only — never video bytes, credentials, cookies, or API keys
// (Section 2.2).
//
// `EventPayloads` is the contract our own send() call sites are written
// against; it is not wired into the Inngest client's own generics because
// v4's typed-client API (the old EventSchemas builder) has changed and
// isn't settled on yet — revisit once Phase 3 picks a final approach.
export type EventPayloads = {
  'reel/job.created': {
    jobId: string;
    toolSlug: string;
    toolName: string;
    url: string;
    stages: StageName[];
    headed?: boolean;
  };
  'reel/job.stop-requested': {
    jobId: string;
  };
  // EXTRACT-* asset extraction (job_type 'extract') — a single-task job,
  // not a step in the reel pipeline's stage graph, so it gets its own
  // event/function (run-extract-job.ts) rather than a 9th StageName.
  'extract/job.created': {
    jobId: string;
    toolSlug: string;
    toolName: string;
    url: string;
    headed?: boolean;
  };
};

export const inngest = new Inngest({ id: 'reel-pipeline' });
