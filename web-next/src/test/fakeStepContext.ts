import type { SweepContext } from '@/inngest/functions/sweepContext';

// A fake Inngest context for calling sweep handlers directly in tests.
// step.run here just executes immediately — it doesn't replicate
// Inngest's own durable step memoization/retry behavior. That's
// deliberate: these tests verify the sweeps' business logic end-to-end
// against a fake backing store, not Inngest's own runtime guarantees,
// which are Inngest's responsibility to test, not ours.
//
// `stepLog`, if given, records each step.run id in call order — opt-in
// and additive, so every existing call site (which just checks end
// state) is unaffected. Needed for the cancellation-before-start
// regression tests, which care about *ordering* (did the cancellation
// check run before the job was marked 'running'?), not just the final
// DB state — a test asserting only end state could pass even if a
// future regression swapped the two steps back, as long as the net
// effect on job_stages happened to look the same.
export function createFakeSweepContext(stepLog?: string[]): SweepContext {
  return {
    step: {
      run: async (id, fn) => {
        stepLog?.push(id);
        return fn();
      },
    },
    logger: {
      info: () => {},
      error: () => {},
    },
  };
}
