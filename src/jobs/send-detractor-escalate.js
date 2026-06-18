// CLI: `node src/jobs/send-detractor-escalate.js`
// Stage 318 — escalate detractor feedback older than 48h still in NEW.
import { db } from '../lib/db.js';
import { escalateStaleDetractors } from '../services/detractorEscalate.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-detractor-escalate] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-detractor-escalate', async () => {
    return await escalateStaleDetractors({});
  });
  console.log(`[send-detractor-escalate] candidates=${result.candidateCount} enqueued=${result.enqueued} owners=${result.ownerCount} skipped=${result.skipped}`);
  console.log(`[send-detractor-escalate] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-detractor-escalate] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
