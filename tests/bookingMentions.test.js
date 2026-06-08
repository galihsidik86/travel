import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking, tempUser, fakeReq } from './_helpers.js';
import { updateBookingNotes } from '../src/services/bookingAdmin.js';
import { getMyMentions } from '../src/services/bookingMentions.js';

test('updateBookingNotes: BookingMention row created per new mention', async (t) => {
  const tag = makeTag('bm-create');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });

  t.after(async () => {
    await db.bookingMention.deleteMany({ where: { bookingId: booking.id } });
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  await updateBookingNotes({
    req: fakeReq,
    actor: { id: actor.id, email: actor.email, role: 'OWNER' },
    bookingId: booking.id,
    notes: `please follow up @${target.email}`,
  });

  const mentions = await db.bookingMention.findMany({
    where: { bookingId: booking.id, userEmail: target.email },
  });
  assert.equal(mentions.length, 1, 'one BookingMention row inserted');
  assert.equal(mentions[0].userId, target.id);
  assert.equal(mentions[0].mentionedByEmail, actor.email);
  assert.equal(mentions[0].mentionedById, actor.id);
});

test('updateBookingNotes: no duplicate BookingMention on repeat save', async (t) => {
  const tag = makeTag('bm-dupe');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });

  t.after(async () => {
    await db.bookingMention.deleteMany({ where: { bookingId: booking.id } });
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: booking.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  const notes1 = `pls follow up @${target.email}`;
  await updateBookingNotes({ req: fakeReq, actor: { id: actor.id, email: actor.email, role: 'OWNER' }, bookingId: booking.id, notes: notes1 });
  await updateBookingNotes({ req: fakeReq, actor: { id: actor.id, email: actor.email, role: 'OWNER' }, bookingId: booking.id, notes: notes1 + ' (update: sudah)' });

  const mentions = await db.bookingMention.count({ where: { bookingId: booking.id, userEmail: target.email } });
  assert.equal(mentions, 1, 'second save with same mention should NOT duplicate');
});

test('getMyMentions: returns latest first within window', async (t) => {
  const tag = makeTag('bm-list');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const b1 = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });
  const actor = await tempUser(t, `${tag}-act`, { role: 'OWNER' });

  t.after(async () => {
    await db.bookingMention.deleteMany({ where: { bookingId: { in: [b1.id, b2.id] } } });
    await db.notification.deleteMany({ where: { relatedEntityId: { in: [b1.id, b2.id] } } });
    await db.auditLog.deleteMany({ where: { entityId: { in: [b1.id, b2.id] } } });
  });

  await updateBookingNotes({ req: fakeReq, actor: { id: actor.id, email: actor.email, role: 'OWNER' }, bookingId: b1.id, notes: `cek @${target.email}` });
  // Tiny delay so timestamps order deterministically.
  await new Promise(r => setTimeout(r, 10));
  await updateBookingNotes({ req: fakeReq, actor: { id: actor.id, email: actor.email, role: 'OWNER' }, bookingId: b2.id, notes: `urgent @${target.email}` });

  const out = await getMyMentions({ userEmail: target.email, days: 30 });
  // Both bookings should be in the rows; latest (b2) first.
  const bookingNos = out.rows.map((r) => r.booking.bookingNo);
  assert.ok(bookingNos.includes(b1.bookingNo));
  assert.ok(bookingNos.includes(b2.bookingNo));
  const b2idx = bookingNos.indexOf(b2.bookingNo);
  const b1idx = bookingNos.indexOf(b1.bookingNo);
  assert.ok(b2idx < b1idx, 'b2 (newer) should appear before b1');
});

test('getMyMentions: respects window (old mentions excluded)', async (t) => {
  const tag = makeTag('bm-win');
  const jemaah = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const target = await tempUser(t, `${tag}-tgt`, { role: 'OWNER' });

  // Insert a BookingMention directly with old createdAt
  const old = await db.bookingMention.create({
    data: {
      bookingId: booking.id,
      userEmail: target.email,
      userId: target.id,
      mentionedByEmail: 'cs@religio.pro',
      createdAt: new Date(Date.now() - 60 * 86_400_000),
    },
  });
  t.after(() => db.bookingMention.deleteMany({ where: { id: old.id } }));

  const r30 = await getMyMentions({ userEmail: target.email, days: 30 });
  const found30 = r30.rows.some((x) => x.id === old.id);
  assert.equal(found30, false, '60d-old mention must NOT appear in 30d window');

  const r90 = await getMyMentions({ userEmail: target.email, days: 90 });
  const found90 = r90.rows.some((x) => x.id === old.id);
  assert.equal(found90, true, 'appears in 90d window');
});

test('getMyMentions: empty user → empty result', async () => {
  const r = await getMyMentions({});
  assert.deepEqual(r.rows, []);
  assert.equal(r.totals.count, 0);
});
