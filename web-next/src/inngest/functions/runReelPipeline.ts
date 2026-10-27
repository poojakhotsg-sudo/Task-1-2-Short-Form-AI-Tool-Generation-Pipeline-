import { inngest } from '@/lib/inngest';
import { setJobStatus, isJobStopping, upsertStageStatus } from '@/lib/jobState';
import { STAGE_ORDER, unmetPrerequisite, type Stage, type StageOutcome } from './stageGraph';
import { runGrabStage } from '../stages/grab';
import { runDescribeStage } from '../stages/describe';
import { runScriptStage } from '../stages/script';
import { runMatchStage } from '../stages/match';
import { runQaStage } from '../stages/qa';
import { runTrialStage } from '../stages/trial';
import { runAssembleStage } from '../stages/assemble';
import { runUploadStage } from '../stages/upload';
import type { StageExecutor, StageExecutorContext } from '../stages/types';
import type { SweepContext } from './sweepContext';

const EXECUTORS: Record<Stage, StageExecutor> = {
  grab: runGrabStage,
  describe: runDescribeStage,
  script: runScriptStage,
  match: runMatchStage,
  qa: runQaStage,
  trial: runTrialStage,
  assemble: runAssembleStage,
  upload: runUploadStage,
};

interface JobCreatedEventData {
  jobId: string;
  toolSlug: string;
  toolName: string;
  url: string;
  stages: Stage[];
  headed?: boolean;
}

// Runs a single stage: upserts 'running', calls its executor, upserts
// 'done' or 'failed' based on the outcome. Everything lives inside one
// step.run per stage (see runReelPipelineHandler) — a retry of that step
// re-runs this whole function from scratch, which is safe because the
// worker call and the DB upserts are both independently idempotent
// (Section 2.2): the worker writes to the same deterministic storage key
// either way, and upsertStageStatus overwrites the same (job_id, stage)
// row rather than duplicating it.
async function executeStage(
  jobId: string,
  stage: Stage,
  ctx: StageExecutorContext
): Promise<StageOutcome> {
  await upsertStageStatus(jobId, stage, {
    status: 'running',
    started_at: new Date().toISOString(),
  });

  try {
    const result = await EXECUTORS[stage](ctx);
    await upsertStageStatus(jobId, stage, {
      status: 'done',
      message: result.message ?? null,
      finished_at: new Date().toISOString(),
    });
    return 'done';
  } catch (err) {
    await upsertStageStatus(jobId, stage, {
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
      finished_at: new Date().toISOString(),
    });
    return 'failed';
  }
}

// Exported separately from createFunction so tests can call it directly
// with a lightweight fake context, without needing Inngest's runtime —
// same pattern as the storage-retention sweeps.
export async function runReelPipelineHandler({
  event,
  step,
  logger,
}: SweepContext & { event: { data: JobCreatedEventData } }) {
  const { jobId, toolSlug, toolName, url, stages, headed } = event.data;
  const requested = new Set<Stage>(stages);
  const outcomes: Partial<Record<Stage, StageOutcome>> = {};
  const ctx: StageExecutorContext = { jobId, toolSlug, toolName, url, headed };

  // Checked BEFORE marking the job 'running', not just between stages:
  // a stop request can arrive in the window between job creation and
  // this function actually starting (e.g. the user cancels an instant
  // after submitting). Without this check, 'mark-job-running' below
  // would unconditionally overwrite that 'stopping' status, clobbering
  // the stop signal before the loop's own per-stage checks ever got a
  // chance to see it. Caught by runReelPipeline.test.ts's cancellation
  // test, which failed against the first version of this function.
  const stoppedBeforeStart = await step.run('check-cancelled-at-start', () => isJobStopping(jobId));
  if (stoppedBeforeStart) {
    await step.run('mark-job-stopped-before-start', () =>
      setJobStatus(jobId, 'stopped', { finished_at: new Date().toISOString() })
    );
    logger.info('run-reel-pipeline: stopped before any stage ran', { jobId });
    return { status: 'stopped', outcomes };
  }

  await step.run('mark-job-running', () =>
    setJobStatus(jobId, 'running', { started_at: new Date().toISOString() })
  );

  for (const stage of STAGE_ORDER) {
    if (!requested.has(stage)) continue;

    // Cooperative cancellation check — see jobState.ts's isJobStopping
    // comment for why this exists alongside Inngest's own `cancelOn` on
    // the function below, rather than relying on cancelOn alone.
    const stopping = await step.run(`check-cancelled-before-${stage}`, () => isJobStopping(jobId));
    if (stopping) {
      await step.run('mark-job-stopped', () =>
        setJobStatus(jobId, 'stopped', { finished_at: new Date().toISOString() })
      );
      logger.info('run-reel-pipeline: stopped by request', { jobId, atStage: stage });
      return { status: 'stopped', outcomes };
    }

    const blocker = unmetPrerequisite(stage, outcomes);
    if (blocker) {
      await step.run(`skip-stage-${stage}`, () =>
        upsertStageStatus(jobId, stage, {
          status: 'skipped',
          skipped_reason: `prerequisite '${blocker}' did not complete`,
        })
      );
      outcomes[stage] = 'skipped';
      continue;
    }

    outcomes[stage] = await step.run(`run-stage-${stage}`, () => executeStage(jobId, stage, ctx));
  }

  const requestedOutcomes = STAGE_ORDER.filter((s) => requested.has(s)).map((s) => outcomes[s]);
  const overall = requestedOutcomes.every((o) => o === 'done') ? 'done' : 'failed';

  await step.run('mark-job-finished', () =>
    setJobStatus(jobId, overall, { finished_at: new Date().toISOString() })
  );

  logger.info('run-reel-pipeline: finished', { jobId, overall, outcomes });
  return { status: overall, outcomes };
}

export const runReelPipeline = inngest.createFunction(
  {
    id: 'run-reel-pipeline',
    retries: 2,
    // Platform-level safety net: stops the function from being
    // scheduled further once a matching cancel event arrives. This is
    // best-effort and can't interrupt a step already executing — the
    // isJobStopping() check above is what gives this app's own DB state
    // a reliable "stopped" outcome regardless of exactly when Inngest's
    // own cancellation takes effect.
    cancelOn: [{ event: 'reel/job.stop-requested', match: 'data.jobId' }],
    triggers: [{ event: 'reel/job.created' }],
  },
  runReelPipelineHandler
);
