// CLI: `node src/jobs/prune.js`
// Run weekly via cron / systemd timer to bound the growth of operational
// tables (notifications, job runs, failed payment intents). See
// src/services/retention.js for what gets pruned and what's kept forever.
import { db } from '../lib/db.js';
import { pruneRetentionWindows } from '../services/retention.js';
import { runJob } from '../lib/jobRunner.js';

const startedAt = new Date();
console.log(`[prune] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('prune', () => pruneRetentionWindows({
    actor: { email: 'system' },
    now: startedAt,
  }));
  console.log(`[prune] notifSent.deleted    = ${result.notifSent.deleted} (cutoff ${result.notifSent.cutoff})`);
  console.log(`[prune] notifFailed.deleted  = ${result.notifFailed.deleted} (cutoff ${result.notifFailed.cutoff})`);
  console.log(`[prune] jobRun.deleted       = ${result.jobRun.deleted} (cutoff ${result.jobRun.cutoff})`);
  console.log(`[prune] intentFailed.deleted = ${result.intentFailed.deleted} (cutoff ${result.intentFailed.cutoff})`);
  console.log(`[prune] total affected       = ${result.affected}`);
  const tookMs = Date.now() - startedAt.getTime();
  console.log(`[prune] done in ${tookMs}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[prune] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
