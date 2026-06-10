// CLI: `node src/jobs/send-doc-expiring.js`
// Stage 173 — daily email to jemaah whose tracked docs expire
// within 30d. Silent on quiet days.
import { db } from '../lib/db.js';
import { sendDocExpiringNudges } from '../services/docExpiringNudge.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-doc-expiring] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-doc-expiring', async () => {
    return await sendDocExpiringNudges({});
  });
  console.log(`[send-doc-expiring] jemaah=${result.jemaahCount} enqueued=${result.enqueued} skipped=${result.skipped} errors=${result.errors}`);
  console.log(`[send-doc-expiring] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-doc-expiring] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
