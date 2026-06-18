// CLI: `node src/jobs/send-help-escalate.js`
// Stage 332 — escalate jemaah help requests older than 2h still unacked.
import { db } from '../lib/db.js';
import { escalateStaleHelpRequests } from '../services/helpRequestEscalate.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-help-escalate] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-help-escalate', async () => {
    return await escalateStaleHelpRequests({});
  });
  console.log(`[send-help-escalate] candidates=${result.candidateCount} enqueued=${result.enqueued} owners=${result.ownerCount} skipped=${result.skipped}`);
  console.log(`[send-help-escalate] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-help-escalate] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
