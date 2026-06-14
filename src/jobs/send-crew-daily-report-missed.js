// CLI: `node src/jobs/send-crew-daily-report-missed.js`
// Stage 279 — morning admin digest of yesterday's missed crew reports.
import { db } from '../lib/db.js';
import { sendCrewDailyReportMissedAdmin } from '../services/crewDailyReportDigest.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-crew-daily-report-missed] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-crew-daily-report-missed', async () => {
    return await sendCrewDailyReportMissedAdmin({});
  });
  console.log(`[send-crew-daily-report-missed] missed=${result.missedCount} recipients=${result.recipientCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-crew-daily-report-missed] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-crew-daily-report-missed] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
