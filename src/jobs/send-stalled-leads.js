// CLI: `node src/jobs/send-stalled-leads.js`
// Daily 08:00 — iterate every ACTIVE agen, build their stalled-lead
// digest (WARM/COLD >7d untouched), and email it. Silent on agents
// with no stalled leads.
import { db } from '../lib/db.js';
import { getStalledLeadsForAgent, listActiveAgentsForLeadsDigest } from '../services/stalledLeadsDigest.js';
import { notifyStalledLeads } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-stalled-leads] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-stalled-leads', async () => {
    const agents = await listActiveAgentsForLeadsDigest();
    let enqueued = 0;
    let skipped = 0;
    let errors = 0;
    for (const a of agents) {
      try {
        const digest = await getStalledLeadsForAgent({ agentId: a.id });
        if (!digest || digest.rows.length === 0) { skipped += 1; continue; }
        const r = await notifyStalledLeads({ agent: a, digest });
        enqueued += r.enqueued ?? 0;
      } catch (err) {
        console.warn(`[send-stalled-leads] agent ${a.slug} failed:`, err?.message || err);
        errors += 1;
      }
    }
    return { agents: agents.length, enqueued, skipped, errors };
  });
  console.log(`[send-stalled-leads] agents=${result.agents} enqueued=${result.enqueued} skipped=${result.skipped} errors=${result.errors}`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-stalled-leads] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
