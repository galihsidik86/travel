// CLI: `node src/jobs/send-pickup-reminder.js`
// Stage 219 — daily pickup choice reminder. Targets active bookings on
// soon-departing paket (≤14d) where the jemaah hasn't picked a pickup.
import { db } from '../lib/db.js';
import { sendPickupReminders } from '../services/pickupReminder.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-pickup-reminder] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-pickup-reminder', async () => sendPickupReminders({}));
  console.log(
    `[send-pickup-reminder] bookingCount=${result.bookingCount} enqueued=${result.enqueued} ` +
    `skipped=${result.skipped} errors=${result.errors}`,
  );
  console.log(`[send-pickup-reminder] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-pickup-reminder] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
