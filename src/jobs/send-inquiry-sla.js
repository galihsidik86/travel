// CLI: `node src/jobs/send-inquiry-sla.js`
// Stage 291 — daily admin digest of stale public inquiries.
import { db } from '../lib/db.js';
import { sendInquirySlaDigest } from '../services/inquirySlaDigest.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-inquiry-sla] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-inquiry-sla', async () => {
    return await sendInquirySlaDigest({});
  });
  console.log(`[send-inquiry-sla] rows=${result.rowCount} recipients=${result.recipientCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-inquiry-sla] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-inquiry-sla] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
