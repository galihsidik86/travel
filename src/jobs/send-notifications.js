// CLI: `node src/jobs/send-notifications.js`
// Designed for system cron — typically every 1–5 minutes for near-real-time delivery.
// Exits 0 on success, 1 on unexpected error. Per-notif failures are written into
// Notification.error and don't abort the run.
import { db } from '../lib/db.js';
import { processPendingNotifications } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-notifications] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-notifications', () => processPendingNotifications());
  console.log(`[send-notifications] processed=${result.processed} sent=${result.sent} failed=${result.failed} skipped=${result.skipped}`);
  const tookMs = Date.now() - startedAt.getTime();
  console.log(`[send-notifications] done in ${tookMs}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-notifications] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
