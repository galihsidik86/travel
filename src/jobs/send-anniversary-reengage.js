// CLI: `node src/jobs/send-anniversary-reengage.js`
// Stage 308 — daily 365d-anniversary re-engagement nudge.
import { db } from '../lib/db.js';
import { sendAnniversaryReengage } from '../services/anniversaryReengage.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-anniversary-reengage] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-anniversary-reengage', async () => {
    return await sendAnniversaryReengage({});
  });
  console.log(`[send-anniversary-reengage] candidates=${result.candidateCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-anniversary-reengage] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-anniversary-reengage] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
