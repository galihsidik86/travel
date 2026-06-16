// CLI: `node src/jobs/send-birthday-greeting.js`
// Stage 307 — daily ulang-tahun greeting WA+EMAIL.
import { db } from '../lib/db.js';
import { sendBirthdayGreetings } from '../services/birthdayGreeting.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-birthday-greeting] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-birthday-greeting', async () => {
    return await sendBirthdayGreetings({});
  });
  console.log(`[send-birthday-greeting] candidates=${result.candidateCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-birthday-greeting] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-birthday-greeting] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
