import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser } from './_helpers.js';
import { getOverdueTasks } from '../src/services/tasks.js';
import { notifyTaskOverdueEscalation } from '../src/services/notifications.js';

test('getOverdueTasks: returns OPEN tasks > grace hours past dueAt', async (t) => {
  const tag = makeTag('to-fetch');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const wayOverdue = await db.task.create({
    data: {
      bookingId: booking.id,
      assigneeEmail: `${tag}@example.test`,
      body: 'old task',
      dueAt: new Date(Date.now() - 5 * 86_400_000), // 5d overdue
    },
  });
  const justBarely = await db.task.create({
    data: {
      bookingId: booking.id,
      assigneeEmail: `${tag}@example.test`,
      body: 'recent task',
      dueAt: new Date(Date.now() - 12 * 60 * 60_000), // 12h overdue
    },
  });
  const future = await db.task.create({
    data: {
      bookingId: booking.id,
      assigneeEmail: `${tag}@example.test`,
      body: 'future task',
      dueAt: new Date(Date.now() + 86_400_000),
    },
  });
  t.after(() => db.task.deleteMany({ where: { id: { in: [wayOverdue.id, justBarely.id, future.id] } } }));

  // 48h grace — only the 5-day-old should appear.
  const r = await getOverdueTasks({ graceHours: 48 });
  const ids = r.rows.map((x) => x.id);
  assert.ok(ids.includes(wayOverdue.id), '5d-overdue should appear');
  assert.ok(!ids.includes(justBarely.id), '12h-overdue must NOT appear (under 48h grace)');
  assert.ok(!ids.includes(future.id), 'future task must NOT appear');
});

test('getOverdueTasks: skips DONE/CANCELLED tasks', async (t) => {
  const tag = makeTag('to-status');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const done = await db.task.create({
    data: {
      bookingId: booking.id,
      assigneeEmail: `${tag}@example.test`,
      body: 'done task',
      dueAt: new Date(Date.now() - 5 * 86_400_000),
      status: 'DONE',
    },
  });
  const cancelled = await db.task.create({
    data: {
      bookingId: booking.id,
      assigneeEmail: `${tag}@example.test`,
      body: 'cancelled task',
      dueAt: new Date(Date.now() - 5 * 86_400_000),
      status: 'CANCELLED',
    },
  });
  t.after(() => db.task.deleteMany({ where: { id: { in: [done.id, cancelled.id] } } }));

  const r = await getOverdueTasks({ graceHours: 48 });
  const ids = r.rows.map((x) => x.id);
  assert.ok(!ids.includes(done.id));
  assert.ok(!ids.includes(cancelled.id));
});

test('notifyTaskOverdueEscalation: silent on empty overdue list', async () => {
  const r = await notifyTaskOverdueEscalation({ overdueResult: { rows: [], counts: { overdue: 0, graceHours: 48 } } });
  assert.equal(r.skipped, true);
  assert.equal(r.enqueued, 0);
});

test('notifyTaskOverdueEscalation: enqueues per admin, deduplicates within 7d', async (t) => {
  const tag = makeTag('to-fan');
  const own = await tempUser(t, `${tag}-o`, { role: 'OWNER' });
  await tempUser(t, `${tag}-k`, { role: 'KASIR' });  // should NOT receive

  t.after(async () => {
    await db.notification.deleteMany({ where: { type: 'TASK_OVERDUE_ESCALATION', recipientEmail: { contains: tag } } });
  });

  const fakeOverdue = {
    rows: [{
      id: 'fake', body: 'do x', dueAt: new Date(Date.now() - 5 * 86_400_000),
      assigneeEmail: 'a@x.io',
      booking: { id: 'b1', bookingNo: 'RP-X-1', jemaah: { fullName: 'X' }, paket: { title: 'P', slug: 'p' } },
    }],
    counts: { overdue: 1, graceHours: 48 },
  };

  // First fire: OWNER gets one row
  const r1 = await notifyTaskOverdueEscalation({ overdueResult: fakeOverdue });
  const ownNotif = await db.notification.findFirst({ where: { type: 'TASK_OVERDUE_ESCALATION', recipientEmail: own.email } });
  assert.ok(ownNotif, 'OWNER should receive');

  // KASIR explicitly excluded
  const kasirNotif = await db.notification.findFirst({ where: { type: 'TASK_OVERDUE_ESCALATION', recipientEmail: { contains: `${tag}-k` } } });
  assert.equal(kasirNotif, null);

  // Mark the OWNER notif as SENT recently so the dedup query picks it up
  await db.notification.update({
    where: { id: ownNotif.id },
    data: { status: 'SENT', sentAt: new Date() },
  });

  // Second fire (same day): OWNER should be deduped out
  const r2 = await notifyTaskOverdueEscalation({ overdueResult: fakeOverdue });
  const ownNotifs = await db.notification.findMany({ where: { type: 'TASK_OVERDUE_ESCALATION', recipientEmail: own.email } });
  // Still 1 row (the second call deduped this recipient)
  assert.equal(ownNotifs.length, 1, 'no second enqueue within 7d cooldown');
});
