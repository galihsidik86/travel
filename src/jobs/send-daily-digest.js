// CLI: `node src/jobs/send-daily-digest.js`
// Designed for system cron — runs ~07:00 local time daily. Builds the activity
// digest for "yesterday" (resolveYesterday in the service uses wall-clock now)
// and fans out one EMAIL row per ACTIVE OWNER into the notifications queue.
// Per-row dispatch is handled by send-notifications worker (in-process or cron).
//
// Exits 0 on success, 1 on unexpected error. Re-running on the same day is
// safe — the digest payload is deterministic for a given window, so duplicate
// runs just enqueue duplicate emails. Operationally, cron should fire once
// per day; the runJob row is the operator's trail.
import { db } from '../lib/db.js';
import { buildDailyDigest } from '../services/dailyDigest.js';
import { notifyDailyDigest } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-daily-digest] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-daily-digest', async () => {
    const digest = await buildDailyDigest();
    const fan = await notifyDailyDigest({ digest });
    return {
      date: digest.date,
      recipients: fan.recipients ?? 0,
      enqueued: fan.enqueued ?? 0,
    };
  });
  console.log(`[send-daily-digest] date=${result.date} recipients=${result.recipients} enqueued=${result.enqueued}`);
  const tookMs = Date.now() - startedAt.getTime();
  console.log(`[send-daily-digest] done in ${tookMs}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-daily-digest] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
