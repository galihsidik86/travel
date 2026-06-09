// CLI: `node src/jobs/detect-no-shows.js`
// Stage 144 — daily no-show detection. Stamps Booking.noShowAt for
// active bookings on departed paket with zero attendance on day 1.
import { db } from '../lib/db.js';
import { detectNoShows } from '../services/noShow.js';
import { runJob } from '../lib/jobRunner.js';

const startedAt = new Date();
console.log(`[detect-no-shows] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('detect-no-shows', async () => {
    const r = await detectNoShows();
    return { found: r.found, marked: r.marked };
  });
  console.log(`[detect-no-shows] found=${result.found} marked=${result.marked}`);
  console.log(`[detect-no-shows] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[detect-no-shows] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
