import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser, fakeReq } from './_helpers.js';
import { extractTodos, upsertTodosForBooking, getMyOpenTasks, completeTask, cancelTask } from '../src/services/tasks.js';
import { updateBookingNotes } from '../src/services/bookingAdmin.js';

function localYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('extractTodos: parses single TODO with due date', () => {
  const out = extractTodos('cek dengan @cs@religio.pro TODO follow up paspor by 2026-06-20');
  assert.equal(out.length, 1);
  assert.equal(out[0].assigneeEmail, 'cs@religio.pro');
  assert.equal(out[0].body, 'follow up paspor');
  // Date stored as local midnight; compare local YMD to dodge TZ offsets
  assert.equal(localYmd(out[0].dueAt), '2026-06-20');
});

test('extractTodos: TODO without due date → dueAt null', () => {
  const out = extractTodos('@ops@x.io TODO panggilan ulang besok');
  assert.equal(out.length, 1);
  assert.equal(out[0].dueAt, null);
  assert.equal(out[0].body, 'panggilan ulang besok');
});

test('extractTodos: case-insensitive todo keyword', () => {
  const out = extractTodos('@ops@x.io todo lowercase ok');
  assert.equal(out.length, 1);
});

test('extractTodos: chained TODOs separated by ; or newline', () => {
  const out = extractTodos('@a@x.io TODO first thing; @b@x.io TODO second thing by 2026-12-01');
  assert.equal(out.length, 2);
  assert.equal(out[0].assigneeEmail, 'a@x.io');
  assert.equal(out[0].body, 'first thing');
  assert.equal(out[1].assigneeEmail, 'b@x.io');
  assert.equal(localYmd(out[1].dueAt), '2026-12-01');
});

test('extractTodos: mention without TODO is NOT a task', () => {
  const out = extractTodos('@cs@religio.pro just a heads-up, nothing actionable');
  assert.equal(out.length, 0);
});

test('extractTodos: malformed due date → dueAt null, body preserves text', () => {
  const out = extractTodos('@a@x.io TODO ping vendor by notadate');
  assert.equal(out.length, 1);
  assert.equal(out[0].dueAt, null);
  assert.equal(out[0].body, 'ping vendor by notadate');
});

test('upsertTodosForBooking: creates Task, idempotent on resave', async (t) => {
  const tag = makeTag('task-cr');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });

  t.after(async () => {
    await db.task.deleteMany({ where: { bookingId: booking.id } });
  });

  const notes = `please @${target.email} TODO verify passport by 2026-08-15`;
  const r1 = await upsertTodosForBooking({ bookingId: booking.id, notes, actor: { id: actor.id, email: actor.email } });
  assert.equal(r1.created, 1);

  const tasks = await db.task.findMany({ where: { bookingId: booking.id } });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].assigneeEmail, target.email);
  assert.equal(tasks[0].assigneeId, target.id, 'assigneeId resolved from active user');

  // Re-save same notes → no duplicate
  const r2 = await upsertTodosForBooking({ bookingId: booking.id, notes, actor: { id: actor.id, email: actor.email } });
  assert.equal(r2.created, 0);
  assert.equal(r2.skipped, 1);

  const stillOne = await db.task.count({ where: { bookingId: booking.id } });
  assert.equal(stillOne, 1);
});

test('updateBookingNotes: integrates TODO extraction', async (t) => {
  const tag = makeTag('task-int');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });

  t.after(async () => {
    await db.task.deleteMany({ where: { bookingId: booking.id } });
    await db.bookingMention.deleteMany({ where: { bookingId: booking.id } });
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  await updateBookingNotes({
    req: fakeReq,
    actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    bookingId: booking.id,
    notes: `please @${target.email} TODO call jemaah back today`,
  });

  const tasks = await db.task.findMany({ where: { bookingId: booking.id } });
  assert.equal(tasks.length, 1, 'one task created via updateBookingNotes');
  assert.equal(tasks[0].body, 'call jemaah back today');
});

test('getMyOpenTasks: returns open tasks, overdue first', async (t) => {
  const tag = makeTag('task-list');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });

  const overdue = await db.task.create({
    data: {
      bookingId: booking.id,
      assigneeEmail: target.email,
      assigneeId: target.id,
      body: 'overdue task',
      dueAt: new Date(Date.now() - 86_400_000),
    },
  });
  const future = await db.task.create({
    data: {
      bookingId: booking.id,
      assigneeEmail: target.email,
      assigneeId: target.id,
      body: 'future task',
      dueAt: new Date(Date.now() + 86_400_000 * 7),
    },
  });
  t.after(() => db.task.deleteMany({ where: { id: { in: [overdue.id, future.id] } } }));

  const r = await getMyOpenTasks({ assigneeEmail: target.email });
  const overdueIdx = r.rows.findIndex((x) => x.id === overdue.id);
  const futureIdx = r.rows.findIndex((x) => x.id === future.id);
  assert.ok(overdueIdx < futureIdx, 'overdue (older dueAt) listed before future');
  assert.ok(r.totals.overdue >= 1);
});

test('completeTask / cancelTask: status + timestamps stamped', async (t) => {
  const tag = makeTag('task-state');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });

  const task = await db.task.create({
    data: { bookingId: booking.id, assigneeEmail: target.email, body: 'do thing' },
  });
  t.after(() => db.task.deleteMany({ where: { id: task.id } }));

  const done = await completeTask({ id: task.id, actor: { id: actor.id, email: actor.email } });
  assert.equal(done.status, 'DONE');
  assert.ok(done.completedAt instanceof Date);
  assert.equal(done.completedByEmail, actor.email);
});
