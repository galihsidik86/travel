// CLI: `node src/jobs/retry-webhooks.js`
// Stage 109 — pick up PENDING WebhookDelivery rows whose nextRetryAt
// has elapsed and re-fire them. Cron every 2 min (same cadence as the
// notif retry worker).
import { db } from '../lib/db.js';
import { processPendingDeliveries } from '../services/webhooks.js';
import { runJob } from '../lib/jobRunner.js';

const startedAt = new Date();
console.log(`[retry-webhooks] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('retry-webhooks', () => processPendingDeliveries({ limit: 100 }));
  console.log(`[retry-webhooks] processed=${result.processed} ok=${result.succeeded} requeued=${result.requeued} failed=${result.failed} skipped=${result.skipped}`);
  console.log(`[retry-webhooks] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[retry-webhooks] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
