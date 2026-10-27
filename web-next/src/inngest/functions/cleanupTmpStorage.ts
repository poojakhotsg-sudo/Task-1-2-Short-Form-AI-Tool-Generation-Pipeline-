import { inngest } from '@/lib/inngest';
import { deleteKeys, listStaleTmpKeys } from '@/lib/objectStorage';
import type { SweepContext } from './sweepContext';

// Tier 1 of storage-retention-policy.md: in-progress/crashed writes under
// .../jobs/<id>/tmp/, swept 24h after their last write. No DB rows are
// involved — tmp files are deliberately untracked in `assets`, so there's
// nothing to delete there. Runs more often than tiers 2/3 (every 6h, not
// daily) since its whole purpose is bounding how long a crashed stage's
// debris sits around, and 24h is already the shortest window in the
// policy.
//
// Schedule and window are defaults to confirm, not settled (same caveat as
// the other tiers).
const RETENTION_HOURS = 24;

// Exported separately from createFunction so tests can call it directly
// with a lightweight fake context, without needing Inngest's runtime.
export async function cleanupTmpStorageHandler({ step, logger }: SweepContext) {
  const cutoffIso = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  // Split into two steps so a crash between finding and deleting doesn't
  // re-walk the entire storage tree on retry — Inngest memoizes this
  // step's return value and replays it directly.
  const staleKeys = await step.run('find-stale-tmp-keys', () => listStaleTmpKeys(cutoffIso));

  if (staleKeys.length === 0) {
    logger.info('cleanup-tmp-storage: nothing stale', { cutoffIso });
    return { deleted: 0 };
  }

  await step.run('delete-stale-tmp-keys', () => deleteKeys(staleKeys));

  logger.info('cleanup-tmp-storage: swept stale tmp objects', {
    cutoffIso,
    deleted: staleKeys.length,
  });
  return { deleted: staleKeys.length };
}

export const cleanupTmpStorage = inngest.createFunction(
  { id: 'cleanup-tmp-storage', retries: 3, triggers: [{ cron: '0 */6 * * *' }] },
  cleanupTmpStorageHandler
);
