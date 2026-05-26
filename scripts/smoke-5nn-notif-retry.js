// Smoke test for 5nn — notif retry with exponential backoff.
//
// Strategy: install a stub WA sender that fails on demand, enqueue a notif,
// then drive processPendingNotifications repeatedly while observing the
// row state. We manipulate nextRetryAt directly to simulate elapsed backoff
// (otherwise the test would have to wait minutes).
import { db } from '../src/lib/db.js';
import {
  enqueueNotification, processPendingNotifications, setSender, MAX_ATTEMPTS,
} from '../src/services/notifications.js';

const tag = `smoke5nn-${Date.now()}`;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

let mode = 'fail';
function stubSender(_notif) {
  if (mode === 'fail') return { ok: false, error: 'stub: simulated failure' };
  if (mode === 'ok')   return { ok: true };
  return { skip: true, reason: 'stub: skipped' };
}

async function main() {
  console.log(`\n[5nn smoke] tag=${tag} MAX_ATTEMPTS=${MAX_ATTEMPTS}`);

  setSender('WA', stubSender);

  // Enqueue a fresh WA notif
  mode = 'fail';
  const n = await enqueueNotification({
    type: 'PAYMENT_RECEIVED', channel: 'WA',
    recipientPhone: '0812-3456-7890',
    subject: null, body: `retry-test-${tag}`,
    relatedEntity: 'Booking', relatedEntityId: tag,
  });
  assert(n && n.status === 'PENDING' && n.attemptCount === 0, 'enqueue → PENDING attempt=0');

  // 1st pass: fails → FAILED, attemptCount=1, nextRetryAt set in future (~1 min)
  let r = await processPendingNotifications();
  let row = await db.notification.findUnique({ where: { id: n.id } });
  assert(r.failed === 1 && r.sent === 0, '1st process counts as failed');
  assert(row.status === 'FAILED' && row.attemptCount === 1, 'attemptCount → 1');
  assert(row.nextRetryAt && row.nextRetryAt.getTime() > Date.now(), 'nextRetryAt scheduled in future');
  const firstDelayMs = row.nextRetryAt.getTime() - Date.now();
  assert(firstDelayMs > 55_000 && firstDelayMs <= 65_000, `1st backoff ~= 1min (got ${firstDelayMs}ms)`);

  // 2nd pass without elapsing backoff: row NOT picked up
  r = await processPendingNotifications();
  row = await db.notification.findUnique({ where: { id: n.id } });
  assert(r.processed === 0, 'within backoff window → row skipped by query');
  assert(row.attemptCount === 1, 'attemptCount unchanged');

  // Simulate elapsed backoff: rewind nextRetryAt to past
  await db.notification.update({
    where: { id: n.id },
    data: { nextRetryAt: new Date(Date.now() - 1000) },
  });

  // 2nd real attempt: still failing → attemptCount=2, longer backoff (~5min)
  r = await processPendingNotifications();
  row = await db.notification.findUnique({ where: { id: n.id } });
  assert(row.attemptCount === 2, 'attemptCount → 2 after backoff elapses');
  const secondDelayMs = row.nextRetryAt.getTime() - Date.now();
  assert(secondDelayMs > 4 * 60_000 && secondDelayMs < 6 * 60_000, `2nd backoff ~= 5min (got ${secondDelayMs}ms)`);

  // Drive to exhaustion: keep rewinding + reprocessing until terminal
  for (let i = 3; i <= MAX_ATTEMPTS; i++) {
    await db.notification.update({
      where: { id: n.id },
      data: { nextRetryAt: new Date(Date.now() - 1000) },
    });
    await processPendingNotifications();
    row = await db.notification.findUnique({ where: { id: n.id } });
    assert(row.attemptCount === i, `attempt ${i} consumed`);
  }
  assert(row.status === 'FAILED' && row.nextRetryAt === null,
    `terminal FAILED at attempt ${MAX_ATTEMPTS} (no more nextRetryAt)`);

  // Process again — terminal row must NOT be picked up
  r = await processPendingNotifications();
  assert(r.processed === 0, 'terminal FAILED not re-queued');

  // Admin manual reset path: simulate the /admin/notifications/:id/send route
  // (reset attemptCount=0 + status=PENDING then dispatch).
  mode = 'ok';
  await db.notification.update({
    where: { id: n.id },
    data: { status: 'PENDING', attemptCount: 0, nextRetryAt: null, error: null },
  });
  r = await processPendingNotifications();
  row = await db.notification.findUnique({ where: { id: n.id } });
  assert(r.sent === 1, 'after admin reset + sender fixed → 1 sent');
  assert(row.status === 'SENT' && row.attemptCount === 1 && row.nextRetryAt === null,
    'SENT terminal: attemptCount=1 (this attempt), no future retry');

  // Cleanup
  await db.notification.delete({ where: { id: n.id } });
  console.log('\n[5nn smoke] PASS\n');
}

main()
  .catch((err) => { console.error('[5nn smoke] ERROR:', err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
