// Contract every per-stage executor implements. Deliberately minimal and
// free of job_stages/worker specifics — the orchestrator (runReelPipeline.ts)
// owns writing stage status; an executor just does the stage's actual
// work and either returns a result or throws.
export interface StageExecutorContext {
  jobId: string;
  toolSlug: string;
  toolName: string;
  url: string;
  headed?: boolean;
}

export interface StageExecutorResult {
  message?: string;
  data?: Record<string, unknown>;
}

export type StageExecutor = (ctx: StageExecutorContext) => Promise<StageExecutorResult>;

// The object-storage prefix a stage's own output belongs under, per
// object-storage-layout.md's convention. Every worker-delegating stage
// passes this so the worker writes to the right place without the
// orchestrator needing to know the worker's internal file layout.
export function stageStoragePrefix(ctx: StageExecutorContext, stage: string): string {
  return `private/tools/${ctx.toolSlug}/jobs/${ctx.jobId}/${stage}/`;
}
