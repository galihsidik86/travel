import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser, fakeReq } from './_helpers.js';
import { getBookingActivityFeed } from '../src/services/bookingActivity.js';
import { recordPayment } from '../src/services/payment.js';
import { updateBookingNotes } from '../src/services/bookingAdmin.js';

test('getBookingActivityFeed: empty bookingId → empty result', async () => {
  const r = await getBookingActivityFeed(null);
  assert.deepEqual(r.rows, []);
});

test('getBookingActivityFeed: merges payments + tasks + mentions in chronological order', async (t) => {
  const tag = makeTag('act-merge');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });

  t.after(async () => {
    await db.task.deleteMany({ where: { bookingId: booking.id } });
    await db.bookingMention.deleteMany({ where: { bookingId: booking.id } });
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.payment.deleteMany({ where: { bookingId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  // 1. Notes with mention + TODO → spawns mention + task rows
  await updateBookingNotes({
    req: fakeReq,
    actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    bookingId: booking.id,
    notes: `please @${target.email} TODO verify passport`,
  });
  // 2. A payment
  await recordPayment({
    req: fakeReq,
    actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    bookingId: booking.id,
    amount: '300000', method: 'TRANSFER',
  });

  const feed = await getBookingActivityFeed(booking.id);
  assert.ok(feed.rows.length >= 3, 'should have audit + payment + task + mention rows');

  const kinds = feed.rows.map((r) => r.kind);
  assert.ok(kinds.includes('payment'), 'payment present');
  assert.ok(kinds.includes('task'), 'task present');
  assert.ok(kinds.includes('mention'), 'mention present');
  assert.ok(kinds.includes('audit'), 'audit present');

  // Verify chronological sort (newest first)
  for (let i = 1; i < feed.rows.length; i++) {
    assert.ok(feed.rows[i - 1].when.getTime() >= feed.rows[i].when.getTime(),
      `row ${i - 1} should be >= row ${i} (newest first)`);
  }
});

test('getBookingActivityFeed: limit caps the output', async (t) => {
  const tag = makeTag('act-cap');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });

  t.after(async () => {
    await db.payment.deleteMany({ where: { bookingId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  for (let i = 0; i < 5; i += 1) {
    await recordPayment({
      req: fakeReq, actor: { id: actor.id, email: actor.email, role: 'OWNER' },
      bookingId: booking.id, amount: '10000', method: 'CASH',
    });
  }

  const feed = await getBookingActivityFeed(booking.id, { limit: 3 });
  assert.equal(feed.rows.length, 3, 'capped at limit');
  assert.ok(feed.counts.total >= 5, 'totals reflect the uncapped count');
});

test('getBookingActivityFeed: task with completion shows TWO rows (create + complete)', async (t) => {
  const tag = makeTag('act-task2');
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });

  const task = await db.task.create({
    data: {
      bookingId: booking.id,
      assigneeEmail: target.email,
      body: 'do thing',
      status: 'DONE',
      completedAt: new Date(),
      completedByEmail: target.email,
    },
  });
  t.after(() => db.task.deleteMany({ where: { id: task.id } }));

  const feed = await getBookingActivityFeed(booking.id);
  const taskRows = feed.rows.filter((r) => r.kind === 'task');
  assert.equal(taskRows.length, 2, 'create row + complete row');
});
