// CLI: `node src/jobs/send-crew-weekly-digest.js`
// Monday 07:20 — per-crew weekly recap. Loops every ACTIVE MUTHAWWIF
// with email, builds buildCrewWeeklyDigest, fans out email if there's
// any activity OR upcoming assignments. Silent on idle crew weeks.
import { db } from '../lib/db.js';
import { buildCrewWeeklyDigest, listActiveCrewForDigest } from '../services/crewWeeklyDigest.js';
import { notifyCrewWeeklyDigest } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-crew-weekly-digest] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-crew-weekly-digest', async () => {
    const crew = await listActiveCrewForDigest();
    let enqueued = 0;
    let skipped = 0;
    let errors = 0;
    for (const c of crew) {
      try {
        const digest = await buildCrewWeeklyDigest({ userId: c.id });
        if (!digest) { skipped += 1; continue; }
        const r = await notifyCrewWeeklyDigest({ digest });
        if (r.skipped) skipped += 1;
        enqueued += r.enqueued ?? 0;
      } catch (err) {
        console.warn(`[crew-weekly] user ${c.id} failed:`, err?.message || err);
        errors += 1;
      }
    }
    return { crew: crew.length, enqueued, skipped, errors };
  });
  console.log(`[send-crew-weekly-digest] crew=${result.crew} enqueued=${result.enqueued} skipped=${result.skipped} errors=${result.errors}`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-crew-weekly-digest] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
