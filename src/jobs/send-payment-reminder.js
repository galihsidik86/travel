// CLI: `node src/jobs/send-payment-reminder.js`
// Stage 172 — daily reminder for jemaah with unpaid balance < 14d
// to departure. Silent on quiet days.
import { db } from '../lib/db.js';
import { sendPaymentReminders } from '../services/paymentReminder.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-payment-reminder] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-payment-reminder', async () => {
    return await sendPaymentReminders({});
  });
  console.log(`[send-payment-reminder] bookings=${result.bookingCount} enqueued=${result.enqueued} skipped=${result.skipped} errors=${result.errors}`);
  console.log(`[send-payment-reminder] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-payment-reminder] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
