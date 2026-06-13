// CLI: `node src/jobs/send-doc-verify-sla.js`
// Stage 276 — daily admin digest of SUBMITTED docs awaiting verify > 48h.
import { db } from '../lib/db.js';
import { sendDocVerifySlaDigest } from '../services/docVerifySlaDigest.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-doc-verify-sla] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-doc-verify-sla', async () => {
    return await sendDocVerifySlaDigest({});
  });
  console.log(`[send-doc-verify-sla] rows=${result.rowCount} recipients=${result.recipientCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-doc-verify-sla] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-doc-verify-sla] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
