// CLI: `node src/jobs/send-trip-feedback-reminder.js`
// Stage 312 — daily 60d post-return feedback nudge.
import { db } from '../lib/db.js';
import { sendTripFeedbackReminders } from '../services/tripFeedbackReminder.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-trip-feedback-reminder] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-trip-feedback-reminder', async () => {
    return await sendTripFeedbackReminders({});
  });
  console.log(`[send-trip-feedback-reminder] candidates=${result.candidateCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-trip-feedback-reminder] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-trip-feedback-reminder] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
