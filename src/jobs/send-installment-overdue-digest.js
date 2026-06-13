// CLI: `node src/jobs/send-installment-overdue-digest.js`
// Stage 272 — daily admin digest of bookings with overdue installments.
import { db } from '../lib/db.js';
import { sendInstallmentOverdueDigest } from '../services/installmentOverdueDigest.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-installment-overdue-digest] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-installment-overdue-digest', async () => {
    return await sendInstallmentOverdueDigest({});
  });
  console.log(`[send-installment-overdue-digest] rows=${result.rowCount} recipients=${result.recipientCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-installment-overdue-digest] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-installment-overdue-digest] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
