// Authenticated HTTP dispatch to the Phase 4 TypeScript worker (Section
// 2.1/2.2, Section 5's "Worker Task Contract"). The worker itself doesn't
// exist yet — this file is the seam Phase 3's orchestrator calls through,
// so Phase 4 just has to implement these HTTP endpoints, not change how
// Phase 3 calls them. Calling this against a real deployment before the
// worker exists will fail (no WORKER_BASE_URL listening) — that's
// expected, not a bug in this file.

export type WorkerTaskName =
  | 'capture_site'
  | 'extract_media'
  | 'describe_clips'
  | 'normalize_media'
  | 'run_qa'
  | 'assemble_rough_cut'
  | 'create_zip'
  | 'upload_drive'
  // 'record_section', in Section 5's original named list, is deliberately
  // NOT a separate task here: grabber.py has no function literally named
  // record_section, and the actual per-section recording logic
  // (record_shot(), called once per section inside _record_library()'s
  // pass 1) is exactly what capture_site's own loop already does — see
  // worker/src/services/captureSite.ts. Confirmed by reading grabber.py,
  // not assumed from the task's name; nothing calls a 'record_section'
  // task, so it isn't listed as a WorkerTaskName.
  // Not in requirement.md Section 5's named list — that list is
  // introduced with "such as," i.e. explicitly non-exhaustive. Added
  // because PIPE-07's trial recording needs the same Playwright
  // capability the worker already needs for capture_site, and nothing
  // else in this system can do it. Flagging it here rather than silently
  // treating it as if Section 5 had named it.
  | 'record_trial_steps'
  // Also not in Section 5's named list, for the same reason: PIPE-04's
  // script generation needs fetch_site_text()'s real Playwright browser
  // automation (site text + embedded-video info) as a prerequisite to
  // its LLM prompt, which only the worker can do.
  | 'fetch_site_text'
  // Also not in Section 5's named list, for the same reason: PIPE-05's
  // match stage needs grabber.py's record_missing_shot_clips() fallback
  // (real Playwright mobile recording) for any website shot Rules
  // 1/1b/2 couldn't match to an existing clip.
  | 'record_missing_shot_clips';

export interface WorkerTaskResult {
  status: 'ok' | 'error';
  message?: string;
  data?: Record<string, unknown>;
}

const WORKER_BASE_URL = process.env.WORKER_BASE_URL || '';
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || '';

export async function callWorkerTask(
  task: WorkerTaskName,
  payload: Record<string, unknown>
): Promise<WorkerTaskResult> {
  if (!WORKER_BASE_URL) {
    throw new Error('WORKER_BASE_URL is not configured');
  }

  const resp = await fetch(`${WORKER_BASE_URL}/tasks/${task}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(WORKER_AUTH_TOKEN ? { authorization: `Bearer ${WORKER_AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    const detail = (json && typeof json === 'object' && 'message' in json) ? (json as { message: string }).message : resp.statusText;
    throw new Error(`Worker task '${task}' failed (HTTP ${resp.status}): ${detail}`);
  }

  if (!json || typeof json !== 'object' || (json.status !== 'ok' && json.status !== 'error')) {
    throw new Error(`Worker task '${task}' returned an unrecognized response shape`);
  }

  return json as WorkerTaskResult;
}
