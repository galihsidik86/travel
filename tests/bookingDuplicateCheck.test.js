// Stage 167 — duplicate phone detection for the admin walk-in
// booking flow + lead create flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  findRecentBookingsByPhone, findRecentLeadsByPhone, normalisePhone,
} from '../src/services/bookingDuplicateCheck.js';

test('normalisePhone: collapses common ID formats', () => {
  assert.equal(normalisePhone('+62 822-3399-1100'), '6282233991100');
  assert.equal(normalisePhone('0822 3399 1100'), '6282233991100');
  assert.equal(normalisePhone('082233991100'), '6282233991100');
  assert.equal(normalisePhone('62822 33991100'), '6282233991100');
  assert.equal(normalisePhone(''), '');
  assert.equal(normalisePhone(null), '');
});

test('findRecentBookingsByPhone: empty/short phone → empty result', async () => {
  assert.deepEqual(await findRecentBookingsByPhone({ phone: '' }), []);
  assert.deepEqual(await findRecentBookingsByPhone({ phone: '123' }), []);
  assert.deepEqual(await findRecentBookingsByPhone({}), []);
});

test('findRecentBookingsByPhone: matches by normalised phone', async (t) => {
  const tag = makeTag('s167-match');
  const paket = await tempPaket(t, tag);
  const jem = await db.jemaahProfile.create({
    data: { fullName: `Jemaah ${tag}`, phone: '081234567890' },
  });
  const booking = await tempBooking({ paket, jemaahProfileId: jem.id });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: booking.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });

  // Match with +62 prefix variant
  const r1 = await findRecentBookingsByPhone({ phone: '+62 8123 4567890' });
  const mine = r1.find((b) => b.id === booking.id);
  assert.ok(mine, 'matched booking with reformatted phone');
});

test('findRecentBookingsByPhone: excludes CANCELLED bookings', async (t) => {
  const tag = makeTag('s167-cancel');
  const paket = await tempPaket(t, tag);
  const jem = await db.jemaahProfile.create({
    data: { fullName: `Jemaah ${tag}`, phone: '081111222333' },
  });
  const booking = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-X`, paketId: paket.id, jemaahId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500000', paidAmount: '0',
      status: 'CANCELLED',
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: booking.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });

  const r = await findRecentBookingsByPhone({ phone: '081111222333' });
  const mine = r.find((b) => b.id === booking.id);
  assert.equal(mine, undefined, 'CANCELLED booking not surfaced');
});

test('findRecentBookingsByPhone: excludes bookings outside window', async (t) => {
  const tag = makeTag('s167-old');
  const paket = await tempPaket(t, tag);
  const jem = await db.jemaahProfile.create({
    data: { fullName: `Jemaah ${tag}`, phone: '081777888999' },
  });
  // Booking created over a year ago
  const booking = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-OLD`, paketId: paket.id, jemaahId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500000', paidAmount: '0',
      status: 'PENDING', createdAt: new Date('2024-01-01'),
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: booking.id } });
    await db.jemaahProfile.deleteMany({ where: { id: jem.id } });
  });

  const r = await findRecentBookingsByPhone({
    phone: '081777888999',
    now: new Date('2026-06-10'),
    windowDays: 90,
  });
  const mine = r.find((b) => b.id === booking.id);
  assert.equal(mine, undefined, 'old booking outside 90d window not surfaced');
});

test('findRecentBookingsByPhone: tail-match prefilter does not yield false positives', async (t) => {
  const tag = makeTag('s167-tail');
  const paket = await tempPaket(t, tag);
  // Two jemaah with same last-8 digits but different prefixes
  const jem1 = await db.jemaahProfile.create({
    data: { fullName: `J1 ${tag}`, phone: '081155667788' },
  });
  const jem2 = await db.jemaahProfile.create({
    data: { fullName: `J2 ${tag}`, phone: '082155667788' },
  });
  const b1 = await tempBooking({ paket, jemaahProfileId: jem1.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: jem2.id });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: { in: [b1.id, b2.id] } } });
    await db.jemaahProfile.deleteMany({ where: { id: { in: [jem1.id, jem2.id] } } });
  });

  // Query for jem1's exact phone → should NOT return jem2's booking
  const r = await findRecentBookingsByPhone({ phone: '081155667788' });
  const matchedIds = r.map((b) => b.id);
  assert.ok(matchedIds.includes(b1.id), 'jem1 booking matched');
  assert.ok(!matchedIds.includes(b2.id), 'jem2 booking NOT matched (different prefix)');
});

test('findRecentLeadsByPhone: scoped to non-terminal statuses', async (t) => {
  const tag = makeTag('s167-leads');
  // Need an agent for the lead
  const u = await db.user.create({
    data: {
      email: `${tag}@example.test`,
      passwordHash: 'x', role: 'AGEN',
      fullName: `Agen ${tag}`, phone: '+62811',
      agent: { create: { displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE', whatsapp: '+62811' } },
    },
    include: { agent: true },
  });
  const lWarm = await db.lead.create({
    data: { agentId: u.agent.id, fullName: 'W', phone: '081888777666', status: 'WARM', source: 'WA' },
  });
  const lConv = await db.lead.create({
    data: { agentId: u.agent.id, fullName: 'C', phone: '081888777666', status: 'CONVERTED', source: 'WA' },
  });
  t.after(async () => {
    await db.lead.deleteMany({ where: { id: { in: [lWarm.id, lConv.id] } } });
    await db.agentProfile.deleteMany({ where: { id: u.agent.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });

  const r = await findRecentLeadsByPhone({ phone: '081888777666', agentId: u.agent.id });
  const ids = r.map((l) => l.id);
  assert.ok(ids.includes(lWarm.id), 'WARM lead surfaced');
  assert.ok(!ids.includes(lConv.id), 'CONVERTED lead excluded (terminal)');
});
