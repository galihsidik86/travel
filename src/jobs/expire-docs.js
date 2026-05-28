// CLI: `node src/jobs/expire-docs.js`
// Designed to be called by system cron once a day (typically just after midnight).
// Exits 0 on success, 1 on unexpected error. The service itself collects per-doc
// errors and reports them; CLI prints them but does not abort.
import { db } from '../lib/db.js';
import { expireOverdueDocuments } from '../services/expireDocs.js';
import { runJob } from '../lib/jobRunner.js';

const startedAt = new Date();
console.log(`[expire-docs] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('expire-docs', () => expireOverdueDocuments({
    actor: { email: 'system' }, // Role intentionally omitted; not in enum
    now: startedAt,
  }));
  console.log(`[expire-docs] scanned=${result.scanned} expired=${result.expired} errors=${result.errors.length}`);
  for (const e of result.errors) console.warn(`  ! ${e.docId}: ${e.error}`);
  const tookMs = Date.now() - startedAt.getTime();
  console.log(`[expire-docs] done in ${tookMs}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[expire-docs] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
