// CLI: `node src/jobs/send-agent-annual-recap.js`
// Stage 158 — yearly Jan 5 recap of last year's komisi statements per
// agent. Silent on agents with zero statements in the year.
import { db } from '../lib/db.js';
import { sendAgentAnnualRecaps, previousYear } from '../services/agentAnnualRecap.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
const year = previousYear();
console.log(`[send-agent-annual-recap] start ${startedAt.toISOString()} · year=${year}`);

try {
  const result = await runJob('send-agent-annual-recap', () => sendAgentAnnualRecaps({ year }));
  console.log(`[send-agent-annual-recap] agents=${result.agentCount} enqueued=${result.enqueued} skipped=${result.skipped} errors=${result.errors}`);
  console.log(`[send-agent-annual-recap] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-agent-annual-recap] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
