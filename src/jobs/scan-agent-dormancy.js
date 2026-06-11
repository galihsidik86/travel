// CLI: `node src/jobs/scan-agent-dormancy.js`
// Stage 185 — daily scan: flag ACTIVE agents with no booking + no
// lead activity in last 60d as dormant. Auto-clears when activity
// resumes. Logs a one-line summary; silent on quiet days.
import { db } from '../lib/db.js';
import { scanAgentDormancy } from '../services/agentDormancy.js';
import { runJob } from '../lib/jobRunner.js';

const startedAt = new Date();
console.log(`[scan-agent-dormancy] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('scan-agent-dormancy', async () => {
    return await scanAgentDormancy({});
  });
  console.log(`[scan-agent-dormancy] scanned=${result.scanned} flaggedNew=${result.flaggedNew} cleared=${result.cleared} stayedDormant=${result.stayedDormant}`);
  if (result.transitions.length > 0) {
    for (const t of result.transitions) {
      console.log(`[scan-agent-dormancy]   ${t.transition === 'flagged' ? '→ FLAGGED' : '← CLEARED'} ${t.displayName} (${t.slug})`);
    }
  }
  console.log(`[scan-agent-dormancy] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[scan-agent-dormancy] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
