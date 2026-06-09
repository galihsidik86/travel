// CLI: `node src/jobs/generate-komisi-statements.js`
// Stage 150 — monthly per-agent komisi statement generation. Cron Mon
// 1st generates the previous-month statement per active agent.
import { db } from '../lib/db.js';
import { generateAllAgentStatements, previousMonthYM } from '../services/komisiStatement.js';
import { runJob } from '../lib/jobRunner.js';

const startedAt = new Date();
const periodYM = previousMonthYM();
console.log(`[generate-komisi-statements] start ${startedAt.toISOString()} · period=${periodYM}`);

try {
  const result = await runJob('generate-komisi-statements', () => generateAllAgentStatements({ periodYM }));
  console.log(`[generate-komisi-statements] agents=${result.agentCount} created=${result.created} skipped=${result.skipped} errors=${result.errors}`);
  console.log(`[generate-komisi-statements] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[generate-komisi-statements] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
