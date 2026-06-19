// CLI: `node src/jobs/send-first-booking-nudge.js`
// Stage 380 — daily 7d-post-register nudge for jemaah with zero bookings.
import { db } from '../lib/db.js';
import { sendFirstBookingNudges } from '../services/firstBookingNudge.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-first-booking-nudge] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-first-booking-nudge', async () => {
    return await sendFirstBookingNudges({});
  });
  console.log(`[send-first-booking-nudge] candidates=${result.candidateCount} nudged=${result.nudged} enqueued=${result.enqueued} failed=${result.failed}`);
  console.log(`[send-first-booking-nudge] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-first-booking-nudge] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
