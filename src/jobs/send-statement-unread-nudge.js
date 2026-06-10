// CLI: `node src/jobs/send-statement-unread-nudge.js`
// Stage 163 — daily WA nudge to agents whose recent komisi statements
// are unread. Silent on quiet days (no candidates → no enqueue).
import { db } from '../lib/db.js';
import { sendStatementUnreadNudges } from '../services/statementUnreadNudge.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-statement-unread-nudge] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-statement-unread-nudge', async () => {
    return await sendStatementUnreadNudges({});
  });
  console.log(`[send-statement-unread-nudge] agents=${result.agentCount} enqueued=${result.enqueued} skipped=${result.skipped} errors=${result.errors}`);
  console.log(`[send-statement-unread-nudge] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-statement-unread-nudge] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
