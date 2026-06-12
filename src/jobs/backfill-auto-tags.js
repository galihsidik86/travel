// CLI: `node src/jobs/backfill-auto-tags.js`
// Stage 232-234 — auto-tag backfill. Daily pass over active bookings
// on future-departure paket. Additive only; respects admin manual
// removal via `Booking.autoTaggedSeen`.
import { db } from '../lib/db.js';
import { runAutoTagBackfill } from '../services/bookingAutoTag.js';
import { runJob } from '../lib/jobRunner.js';

const startedAt = new Date();
console.log(`[backfill-auto-tags] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('backfill-auto-tags', async () => runAutoTagBackfill({}));
  console.log(`[backfill-auto-tags] scanned=${result.scanned} touched=${result.touched} failed=${result.failed}`);
  console.log(`[backfill-auto-tags] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[backfill-auto-tags] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
