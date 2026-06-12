// CLI: `node src/jobs/auto-publish-paket.js`
// Stage 227 — daily auto-publish of scheduled paket. Flips DRAFT paket
// to ACTIVE when publishedAt <= now (admin can pre-schedule a launch).
import { db } from '../lib/db.js';
import { runAutoPublishPaket } from '../services/autoPublishPaket.js';
import { runJob } from '../lib/jobRunner.js';

const startedAt = new Date();
console.log(`[auto-publish-paket] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('auto-publish-paket', async () => runAutoPublishPaket({}));
  console.log(`[auto-publish-paket] candidates=${result.candidates} published=${result.published} failed=${result.failed}`);
  console.log(`[auto-publish-paket] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[auto-publish-paket] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
