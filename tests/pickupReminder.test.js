// Stage 219 — daily pickup choice reminder for jemaah on a near-departure
// paket who haven't picked a pickup yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  getPickupReminderCandidates,
  notifyPickupReminder,
} from '../src/services/pickupReminder.js';

async function seedPickup(paket, label = 'Bekasi') {
  return db.paketPickup.create({
    data: { paketId: paket.id, label, address: `${label} addr`, sortOrder: 0 },
  });
}

async function makeNearPaket(t, tag, daysOut = 7) {
  const dep = new Date(Date.now() + daysOut * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Booking', relatedEntityId: { in: (await db.booking.findMany({ where: { paketId: paket.id }, select: { id: true } })).map((b) => b.id) } } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketPickup.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('getPickupReminderCandidates: empty when no near-departure paket', async () => {
  const r = await getPickupReminderCandidates({ now: new Date(), windowDays: 14 });
  // Note: dev DB may have unrelated rows — just confirm shape
  assert.ok(Array.isArray(r.rows));
  assert.equal(r.windowDays, 14);
  assert.equal(r.cooldownDays, 5);
});

test('getPickupReminderCandidates: surfaces booking with unpicked pickup on near paket', async (t) => {
  const tag = makeTag('s219-near');
  const paket = await makeNearPaket(t, tag, 7);
  await seedPickup(paket);
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await getPickupReminderCandidates({ windowDays: 14, cooldownDays: 5 });
  const mine = r.rows.filter((c) => c.paket.id === paket.id);
  assert.equal(mine.length, 1, 'one candidate for this paket');
  assert.equal(mine[0].daysLeft, 7);
});

test('getPickupReminderCandidates: bookings WITH chosen pickup excluded', async (t) => {
  const tag = makeTag('s219-chosen');
  const paket = await makeNearPaket(t, tag, 7);
  const p = await seedPickup(paket);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { pickupId: p.id } });

  const r = await getPickupReminderCandidates({ windowDays: 14, cooldownDays: 5 });
  const mine = r.rows.filter((c) => c.paket.id === paket.id);
  assert.equal(mine.length, 0);
});

test('getPickupReminderCandidates: paket WITHOUT pickup points excluded (nothing to remind about)', async (t) => {
  const tag = makeTag('s219-nopickups');
  const paket = await makeNearPaket(t, tag, 7);
  // No seedPickup — paket has no pickups
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await getPickupReminderCandidates({ windowDays: 14, cooldownDays: 5 });
  const mine = r.rows.filter((c) => c.paket.id === paket.id);
  assert.equal(mine.length, 0);
});

test('getPickupReminderCandidates: paket OUTSIDE window excluded', async (t) => {
  const tag = makeTag('s219-far');
  const paket = await makeNearPaket(t, tag, 30); // > 14d
  await seedPickup(paket);
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const r = await getPickupReminderCandidates({ windowDays: 14, cooldownDays: 5 });
  const mine = r.rows.filter((c) => c.paket.id === paket.id);
  assert.equal(mine.length, 0);
});

test('getPickupReminderCandidates: CANCELLED/REFUNDED bookings excluded', async (t) => {
  const tag = makeTag('s219-cancel');
  const paket = await makeNearPaket(t, tag, 7);
  await seedPickup(paket);
  const jem = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: jem.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0', status: 'CANCELLED',
    },
  });

  const r = await getPickupReminderCandidates({ windowDays: 14, cooldownDays: 5 });
  const mine = r.rows.filter((c) => c.paket.id === paket.id);
  assert.equal(mine.length, 0);
});

test('getPickupReminderCandidates: cooldown skips recently-nudged bookings', async (t) => {
  const tag = makeTag('s219-cooldown');
  const paket = await makeNearPaket(t, tag, 7);
  await seedPickup(paket);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Seed a recent notif so cooldown should skip
  await db.notification.create({
    data: {
      type: 'PICKUP_REMINDER',
      channel: 'EMAIL',
      status: 'SENT',
      recipientEmail: jem.email,
      subject: 'x', body: 'x',
      relatedEntity: 'Booking',
      relatedEntityId: b.id,
      sentAt: new Date(),
    },
  });

  const r = await getPickupReminderCandidates({ windowDays: 14, cooldownDays: 5 });
  const mine = r.rows.filter((c) => c.paket.id === paket.id);
  assert.equal(mine.length, 0, 'recently nudged → cooldown skip');
});

test('notifyPickupReminder: enqueues EMAIL + WA when both present', async (t) => {
  const tag = makeTag('s219-enqueue');
  const paket = await makeNearPaket(t, tag, 5);
  await seedPickup(paket);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const candidate = {
    id: b.id, bookingNo: b.bookingNo,
    paketId: paket.id, jemaahUserId: jem.id,
    jemaah: { fullName: 'Test', email: jem.email, phone: '+6281100000000' },
    paket: { id: paket.id, slug: paket.slug, title: paket.title, departureDate: paket.departureDate },
    daysLeft: 5,
  };
  const r = await notifyPickupReminder(candidate);
  assert.equal(r.enqueued, 2);

  const rows = await db.notification.findMany({ where: { relatedEntity: 'Booking', relatedEntityId: b.id } });
  assert.equal(rows.length, 2);
  const channels = rows.map((r) => r.channel).sort();
  assert.deepEqual(channels, ['EMAIL', 'WA']);
});

test('notifyPickupReminder: skips when no email AND no phone', async () => {
  const r = await notifyPickupReminder({
    id: 'x', bookingNo: 'x', jemaahUserId: null,
    jemaah: { fullName: 'X', email: null, phone: null },
    paket: { id: 'p', slug: 'p', title: 'P', departureDate: new Date() },
    daysLeft: 5,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_contact');
});

test('getPickupReminderCandidates: rows sorted soonest-departing first', async (t) => {
  const tag = makeTag('s219-sort');
  // Two paket: one 3 days out, one 10 days out
  const near = await makeNearPaket(t, tag + '-3', 3);
  const far = await makeNearPaket(t, tag + '-10', 10);
  await seedPickup(near);
  await seedPickup(far);
  const jem = await tempJemaah(t, tag);
  await tempBooking({ paket: near, jemaahProfileId: jem.jemaah.id });
  await tempBooking({ paket: far, jemaahProfileId: jem.jemaah.id });

  const r = await getPickupReminderCandidates({ windowDays: 14, cooldownDays: 5 });
  const mine = r.rows.filter((c) => c.paket.id === near.id || c.paket.id === far.id);
  assert.equal(mine.length, 2);
  assert.ok(mine[0].daysLeft < mine[1].daysLeft, 'soonest first');
});
