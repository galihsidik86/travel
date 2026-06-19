// CLI: `node src/jobs/send-predeparture-readiness.js`
// Stage 351 — daily H-7 pre-departure readiness reminder.
import { db } from '../lib/db.js';
import { sendReadinessReminders } from '../services/predepartureReadinessReminder.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-predeparture-readiness] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-predeparture-readiness', async () => {
    return await sendReadinessReminders({});
  });
  console.log(`[send-predeparture-readiness] candidates=${result.candidateCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-predeparture-readiness] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-predeparture-readiness] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
