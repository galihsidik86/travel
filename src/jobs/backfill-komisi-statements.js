// CLI: `npm run job:backfill-komisi-statements -- --months=6`
// Stage 153 — one-shot backfill of monthly komisi statements for the
// past N months. Idempotent: existing rows skip via the upsert-style
// early-return in generateAgentStatement.
//
// NOT registered as a recurring cron — this is a deliberate one-off
// for first install / new-deployment seeding. Re-running is safe but
// usually a no-op after the first pass.

import { db } from '../lib/db.js';
import { backfillKomisiStatements } from '../services/komisiStatement.js';

// Lightweight arg parser — only handles --months=N
const args = process.argv.slice(2);
let months = 6;
for (const a of args) {
  const m = /^--months=(\d+)$/.exec(a);
  if (m) months = parseInt(m[1], 10);
}

const startedAt = new Date();
console.log(`[backfill-komisi-statements] start ${startedAt.toISOString()} · months=${months}`);

try {
  const result = await backfillKomisiStatements({ months });
  console.log(`[backfill-komisi-statements] done: created=${result.totals.created} skipped=${result.totals.skipped} errors=${result.totals.errors}`);
  console.log('Per-month breakdown:');
  for (const m of result.perMonth) {
    console.log(`  ${m.periodYM}  agents=${m.agentCount}  created=${m.created}  skipped=${m.skipped}  errors=${m.errors}`);
  }
  console.log(`[backfill-komisi-statements] in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[backfill-komisi-statements] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
