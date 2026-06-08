// CLI: `node src/jobs/send-api-scope-down.js`
// Stage 124 — weekly OWNER digest of API keys with granted-but-unused
// scopes (30d window). Silent on healthy weeks.
import { db } from '../lib/db.js';
import { getApiKeyScopeDownCandidates } from '../services/apiKeyScopeDown.js';
import { notifyApiKeyScopeDown } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-api-scope-down] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-api-scope-down', async () => {
    const candidates = await getApiKeyScopeDownCandidates({ days: 30 });
    const fan = await notifyApiKeyScopeDown({ candidates });
    return {
      candidateCount: candidates.rows.length,
      windowDays: candidates.windowDays,
      enqueued: fan.enqueued ?? 0,
      skipped: fan.skipped ?? false,
    };
  });
  console.log(`[send-api-scope-down] candidates=${result.candidateCount} enqueued=${result.enqueued} skipped=${result.skipped}`);
  console.log(`[send-api-scope-down] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-api-scope-down] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
