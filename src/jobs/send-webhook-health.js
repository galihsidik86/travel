// CLI: `node src/jobs/send-webhook-health.js`
// Stage 129 — weekly OWNER/SUPERADMIN digest of per-webhook delivery
// health over the last 7 days. Silent when nothing is unhealthy.
import { db } from '../lib/db.js';
import { getWebhookHealthDigest } from '../services/webhookHealthDigest.js';
import { notifyWebhookHealth } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-webhook-health] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-webhook-health', async () => {
    const digest = await getWebhookHealthDigest({ days: 7 });
    const fan = await notifyWebhookHealth({ digest });
    return {
      totalWebhooks: digest.rows.length,
      unhealthyCount: digest.unhealthyCount,
      enqueued: fan.enqueued ?? 0,
      skipped: fan.skipped ?? false,
    };
  });
  console.log(`[send-webhook-health] webhooks=${result.totalWebhooks} unhealthy=${result.unhealthyCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-webhook-health] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-webhook-health] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
