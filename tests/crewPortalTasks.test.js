// Stage 207 — crew portal sees their own open Tasks (S91).
// Verifies getMyOpenTasks works correctly when scoped by crew email.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempMuthawwif, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getMyOpenTasks } from '../src/services/tasks.js';

async function makeTask({ bookingId, assigneeEmail, body, dueAt = null, status = 'OPEN' }) {
  return db.task.create({
    data: {
      bookingId, assigneeEmail, body, status, dueAt,
      createdByEmail: 'admin@example.test',
    },
  });
}

test('getMyOpenTasks: returns empty when crew has no tasks', async (t) => {
  const tag = makeTag('s207-empty');
  const crew = await tempMuthawwif(t, tag);
  const r = await getMyOpenTasks({ assigneeEmail: crew.email });
  assert.equal(r.rows.length, 0);
  assert.equal(r.totals.open, 0);
});

test('getMyOpenTasks: only OPEN tasks for this crew surface', async (t) => {
  const tag = makeTag('s207-pick');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const openTask = await makeTask({
    bookingId: booking.id, assigneeEmail: crew.email,
    body: 'Confirm jemaah pickup',
  });
  const doneTask = await makeTask({
    bookingId: booking.id, assigneeEmail: crew.email,
    body: 'Already done', status: 'DONE',
  });
  const otherUserTask = await makeTask({
    bookingId: booking.id, assigneeEmail: 'other@example.test',
    body: 'Not for crew',
  });
  t.after(async () => {
    await db.task.deleteMany({ where: { id: { in: [openTask.id, doneTask.id, otherUserTask.id] } } });
  });

  const r = await getMyOpenTasks({ assigneeEmail: crew.email });
  const ids = r.rows.map((row) => row.id);
  assert.ok(ids.includes(openTask.id));
  assert.ok(!ids.includes(doneTask.id), 'DONE excluded');
  assert.ok(!ids.includes(otherUserTask.id), 'other user task excluded');
});

test('getMyOpenTasks: overdue count reflects dueAt < now', async (t) => {
  const tag = makeTag('s207-overdue');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const past = new Date(Date.now() - 86_400_000);
  const future = new Date(Date.now() + 86_400_000);
  const overdueTask = await makeTask({
    bookingId: booking.id, assigneeEmail: crew.email,
    body: 'overdue', dueAt: past,
  });
  const futureTask = await makeTask({
    bookingId: booking.id, assigneeEmail: crew.email,
    body: 'future', dueAt: future,
  });
  t.after(async () => {
    await db.task.deleteMany({ where: { id: { in: [overdueTask.id, futureTask.id] } } });
  });

  const r = await getMyOpenTasks({ assigneeEmail: crew.email });
  assert.equal(r.totals.overdue, 1);
  assert.equal(r.totals.open, 2);
});

test('getMyOpenTasks: sorted by dueAt asc (soonest first)', async (t) => {
  const tag = makeTag('s207-sort');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const late = await makeTask({
    bookingId: booking.id, assigneeEmail: crew.email,
    body: 'late', dueAt: new Date('2099-01-01'),
  });
  const early = await makeTask({
    bookingId: booking.id, assigneeEmail: crew.email,
    body: 'early', dueAt: new Date('2030-01-01'),
  });
  t.after(async () => {
    await db.task.deleteMany({ where: { id: { in: [late.id, early.id] } } });
  });

  const r = await getMyOpenTasks({ assigneeEmail: crew.email });
  const idxEarly = r.rows.findIndex((row) => row.id === early.id);
  const idxLate = r.rows.findIndex((row) => row.id === late.id);
  assert.ok(idxEarly < idxLate);
});

test('getMyOpenTasks: rows include booking + paket + jemaah context', async (t) => {
  const tag = makeTag('s207-context');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  const task = await makeTask({
    bookingId: booking.id, assigneeEmail: crew.email,
    body: 'verify paspor',
  });
  t.after(async () => { await db.task.deleteMany({ where: { id: task.id } }); });

  const r = await getMyOpenTasks({ assigneeEmail: crew.email });
  const row = r.rows.find((x) => x.id === task.id);
  assert.ok(row);
  assert.equal(row.booking.bookingNo, booking.bookingNo);
  assert.ok(row.booking.paket.title);
  assert.ok(row.booking.jemaah.fullName);
});

test('getMyOpenTasks: limit caps row count', async (t) => {
  const tag = makeTag('s207-limit');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  for (let i = 0; i < 5; i++) {
    await makeTask({
      bookingId: booking.id, assigneeEmail: crew.email,
      body: `task ${i}`,
    });
  }
  t.after(async () => {
    await db.task.deleteMany({ where: { assigneeEmail: crew.email } });
  });
  const r = await getMyOpenTasks({ assigneeEmail: crew.email, limit: 3 });
  assert.equal(r.rows.length, 3);
  assert.equal(r.totals.open, 5);
  assert.equal(r.totals.shown, 3);
});

test('getMyOpenTasks: missing assigneeEmail → empty', async () => {
  const r = await getMyOpenTasks({ assigneeEmail: null });
  assert.deepEqual(r.rows, []);
  assert.equal(r.totals.open, 0);
});
