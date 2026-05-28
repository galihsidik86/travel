// CLI: `node src/jobs/expire-intents.js`
// Designed for system cron — typically every 5-15 minutes since intent
// expiration windows are ~1h and "stuck for a few minutes past expiry" is
// fine. Exits 0 on success, 1 on unexpected error.
import { db } from '../lib/db.js';
import { expireStaleIntents } from '../services/expireIntents.js';
import { runJob } from '../lib/jobRunner.js';

const startedAt = new Date();
console.log(`[expire-intents] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('expire-intents', () => expireStaleIntents({
    actor: { email: 'system' }, // role intentionally omitted; not in enum
    now: startedAt,
  }));
  console.log(`[expire-intents] scanned=${result.scanned} expired=${result.expired} errors=${result.errors.length}`);
  for (const e of result.errors) console.warn(`  ! ${e.intentId}: ${e.error}`);
  const tookMs = Date.now() - startedAt.getTime();
  console.log(`[expire-intents] done in ${tookMs}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[expire-intents] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
