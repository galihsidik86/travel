// CLI: `node src/jobs/send-agent-weekly-digest.js`
// Monday ~07:10 — fires after the OWNER weekly so agents read theirs
// once leadership has read theirs. Iterates every ACTIVE agent, builds
// a per-agent week digest, and enqueues one EMAIL row per agent. Failures
// per agent are caught and logged so a bad row doesn't abort the rest.
import { db } from '../lib/db.js';
import { buildAgentWeeklyDigest, listActiveAgentsForDigest } from '../services/agentWeeklyDigest.js';
import { notifyAgentWeeklyDigest } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-agent-weekly-digest] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-agent-weekly-digest', async () => {
    const agents = await listActiveAgentsForDigest();
    let enqueued = 0;
    let skipped = 0;
    let errors = 0;
    for (const a of agents) {
      try {
        const digest = await buildAgentWeeklyDigest({ agentId: a.id });
        if (!digest) { skipped += 1; continue; }
        const fan = await notifyAgentWeeklyDigest({ digest });
        enqueued += fan.enqueued ?? 0;
      } catch (err) {
        console.warn(`[send-agent-weekly-digest] agent ${a.slug} failed:`, err?.message || err);
        errors += 1;
      }
    }
    return { agents: agents.length, enqueued, skipped, errors };
  });
  console.log(`[send-agent-weekly-digest] agents=${result.agents} enqueued=${result.enqueued} skipped=${result.skipped} errors=${result.errors}`);
  const tookMs = Date.now() - startedAt.getTime();
  console.log(`[send-agent-weekly-digest] done in ${tookMs}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-agent-weekly-digest] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
