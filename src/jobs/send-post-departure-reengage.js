// CLI: `node src/jobs/send-post-departure-reengage.js`
// Stage 293 — daily ~30d post-departure re-engagement nudge.
import { db } from '../lib/db.js';
import { sendPostDepartureReengage } from '../services/postDepartureReengage.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-post-departure-reengage] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-post-departure-reengage', async () => {
    return await sendPostDepartureReengage({});
  });
  console.log(`[send-post-departure-reengage] candidates=${result.candidateCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-post-departure-reengage] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-post-departure-reengage] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
