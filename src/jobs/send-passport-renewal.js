// CLI: `node src/jobs/send-passport-renewal.js`
// Stage 203 — daily passport renewal reminder. Targets jemaah whose
// passportExpiry is within 90 days. 30-day cooldown per jemaah.
import { db } from '../lib/db.js';
import { sendPassportRenewalReminders } from '../services/passportRenewalReminder.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-passport-renewal] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-passport-renewal', async () => {
    return await sendPassportRenewalReminders({});
  });
  console.log(`[send-passport-renewal] jemaah=${result.jemaahCount} enqueued=${result.enqueued} skipped=${result.skipped} errors=${result.errors}`);
  console.log(`[send-passport-renewal] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-passport-renewal] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
