// CLI: `node src/jobs/send-crew-dietary-brief.js`
// Stage 213 — Monday morning crew dietary brief. One email per
// (assigned crew × paket departing within 14d). Silent on quiet days.
import { db } from '../lib/db.js';
import { sendCrewDietaryBriefs } from '../services/crewDietaryBrief.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-crew-dietary-brief] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-crew-dietary-brief', async () => sendCrewDietaryBriefs({}));
  console.log(
    `[send-crew-dietary-brief] candidates=${result.candidates} enqueued=${result.enqueued} ` +
    `skipped_no_email=${result.skippedNoEmail} skipped_all_regular=${result.skippedAllRegular} failed=${result.failed}`,
  );
  console.log(`[send-crew-dietary-brief] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-crew-dietary-brief] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
