// CLI: `node src/jobs/send-weekly-digest.js`
// Designed for system cron — runs Monday ~07:00 local time. Builds the
// previous Mon-Sun digest + week-before comparison + topPaket and fans
// out one EMAIL row per ACTIVE OWNER. Idempotent on weekend re-runs:
// resolveLastFullWeek always returns the most-recent complete Mon-Sun.
import { db } from '../lib/db.js';
import { buildWeeklyDigest } from '../services/weeklyDigest.js';
import { notifyWeeklyDigest } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-weekly-digest] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-weekly-digest', async () => {
    const digest = await buildWeeklyDigest();
    const fan = await notifyWeeklyDigest({ digest });
    return {
      weekStart: digest.weekStart,
      recipients: fan.recipients ?? 0,
      enqueued: fan.enqueued ?? 0,
    };
  });
  console.log(`[send-weekly-digest] weekStart=${result.weekStart} recipients=${result.recipients} enqueued=${result.enqueued}`);
  const tookMs = Date.now() - startedAt.getTime();
  console.log(`[send-weekly-digest] done in ${tookMs}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-weekly-digest] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
