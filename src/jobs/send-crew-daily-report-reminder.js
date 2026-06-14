// CLI: `node src/jobs/send-crew-daily-report-reminder.js`
// Stage 279 — evening WA nudge to in-trip crew who haven't submitted today's report.
import { db } from '../lib/db.js';
import { sendCrewDailyReportReminder } from '../services/crewDailyReportDigest.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-crew-daily-report-reminder] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-crew-daily-report-reminder', async () => {
    return await sendCrewDailyReportReminder({});
  });
  console.log(`[send-crew-daily-report-reminder] candidates=${result.candidateCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-crew-daily-report-reminder] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-crew-daily-report-reminder] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
