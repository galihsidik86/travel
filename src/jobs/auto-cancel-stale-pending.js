// CLI: `node src/jobs/auto-cancel-stale-pending.js`
// Stage 237 — daily auto-cancel of PENDING bookings with no payment
// after the stale threshold. Frees kursi for future jemaah.
import { db } from '../lib/db.js';
import { runAutoCancelStalePending } from '../services/autoCancelStalePending.js';
import { runJob } from '../lib/jobRunner.js';

const startedAt = new Date();
console.log(`[auto-cancel-stale-pending] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('auto-cancel-stale-pending', async () => runAutoCancelStalePending({}));
  console.log(`[auto-cancel-stale-pending] candidates=${result.candidates} cancelled=${result.cancelled} failed=${result.failed}`);
  console.log(`[auto-cancel-stale-pending] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[auto-cancel-stale-pending] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
