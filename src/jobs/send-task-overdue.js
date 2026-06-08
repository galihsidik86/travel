// CLI: `node src/jobs/send-task-overdue.js`
// Stage 96 — daily nudge to admin tier when OPEN tasks are 48h+ past dueAt.
// Silent on healthy days. 7-day per-recipient cooldown prevents inbox spam.
import { db } from '../lib/db.js';
import { getOverdueTasks } from '../services/tasks.js';
import { notifyTaskOverdueEscalation } from '../services/notifications.js';
import { bootstrapNotifSenders } from '../lib/notifBootstrap.js';
import { runJob } from '../lib/jobRunner.js';

bootstrapNotifSenders();

const startedAt = new Date();
console.log(`[send-task-overdue] start ${startedAt.toISOString()}`);

try {
  const result = await runJob('send-task-overdue', async () => {
    const overdueResult = await getOverdueTasks();
    const fan = await notifyTaskOverdueEscalation({ overdueResult });
    return {
      overdueCount: overdueResult.counts.overdue,
      graceHours: overdueResult.counts.graceHours,
      recipients: fan.recipients ?? 0,
      enqueued: fan.enqueued ?? 0,
      dedupedRecipients: fan.dedupedRecipients ?? 0,
      skipped: fan.skipped ?? false,
    };
  });
  console.log(`[send-task-overdue] overdue=${result.overdueCount} enqueued=${result.enqueued} dedup=${result.dedupedRecipients} skipped=${result.skipped}`);
  console.log(`[send-task-overdue] done in ${Date.now() - startedAt.getTime()}ms`);
  await db.$disconnect();
  process.exit(0);
} catch (err) {
  console.error('[send-task-overdue] FAILED', err);
  await db.$disconnect();
  process.exit(1);
}
