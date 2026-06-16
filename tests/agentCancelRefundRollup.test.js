// Stage 303 — per-agen cancel/refund rate rollup tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempPaket, tempUser } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { getAgentCancelRefundRollup, KP_SENTINEL, MIN_SAMPLE } from '../src/services/agentCancelRefundRollup.js';

async function tempAgent(t, tag) {
  const user = await db.user.create({
    data: {
      email: `${tag}-ag@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: {
        create: {
          slug: `${tag}-slug`, displayName: `Agen ${tag}`,
          whatsapp: '+62811', tier: 'BRONZE',
        },
      },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientUserId: user.id } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.booking.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

async function makeBooking(paket, jemaahId, agentId, status) {
  return db.booking.create({
    data: {
      bookingNo: `RP-S303-${Math.random().toString(36).slice(2, 8)}`,
      paketId: paket.id, jemaahId, agentId,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '1000000', paidAmount: '0', status,
    },
  });
}

test('S303 — empty when window cutoff is past all bookings', async () => {
  // Far-future `now` → cutoff also future → no booking createdAt matches.
  const result = await getAgentCancelRefundRollup({ days: 1, now: new Date('3000-01-01') });
  assert.deepEqual(result.rows, []);
  assert.equal(result.totals.agentCount, 0);
  assert.equal(result.totals.totalBookings, 0);
  assert.equal(result.totals.overallRatePct, null);
});

test('S303 — groups by agent + computes cancel/refund counts', async (t) => {
  const tag = makeTag('s303a');
  const paket = await tempPaket(t, `${tag}-pkt`);
  const jem = await tempJemaah(t, `${tag}-jem`);
  const agen = await tempAgent(t, `${tag}-a`);

  // 5 bookings: 2 ACTIVE, 2 CANCELLED, 1 REFUNDED.
  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'BOOKED');
  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'LUNAS');
  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'CANCELLED');
  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'CANCELLED');
  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'REFUNDED');

  const result = await getAgentCancelRefundRollup({ days: 90 });
  const row = result.rows.find((r) => r.agentSlug === agen.agent.slug);
  assert.ok(row, 'agent row present');
  assert.equal(row.total, 5);
  assert.equal(row.cancel, 2);
  assert.equal(row.refund, 1);
  assert.equal(row.cancelRatePct, 40);
  assert.equal(row.refundRatePct, 20);
  assert.equal(row.lowSample, false);
});

test('S303 — walk-in bookings bucket under __kp__ sentinel', async (t) => {
  const tag = makeTag('s303b');
  const paket = await tempPaket(t, `${tag}-pkt`);
  const jem = await tempJemaah(t, `${tag}-jem`);

  // 3 walk-in CANCELLED bookings (agentId null).
  await makeBooking(paket, jem.jemaah.id, null, 'CANCELLED');
  await makeBooking(paket, jem.jemaah.id, null, 'CANCELLED');
  await makeBooking(paket, jem.jemaah.id, null, 'BOOKED');

  const result = await getAgentCancelRefundRollup({ days: 90 });
  const kp = result.rows.find((r) => r.agentSlug === KP_SENTINEL);
  assert.ok(kp, 'walk-in bucket present');
  assert.equal(kp.agentName, 'Kantor Pusat');
  assert.ok(kp.total >= 3);
  assert.ok(kp.cancel >= 2);
});

test('S303 — lowSample flag when total < MIN_SAMPLE', async (t) => {
  const tag = makeTag('s303c');
  const paket = await tempPaket(t, `${tag}-pkt`);
  const jem = await tempJemaah(t, `${tag}-jem`);
  const agen = await tempAgent(t, `${tag}-a`);

  // Only 2 bookings — below MIN_SAMPLE (3).
  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'CANCELLED');
  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'BOOKED');

  const result = await getAgentCancelRefundRollup({ days: 90 });
  const row = result.rows.find((r) => r.agentSlug === agen.agent.slug);
  assert.ok(row, 'low-sample row present');
  assert.equal(row.total, 2);
  assert.equal(row.lowSample, true);
  assert.equal(row.cancelRatePct, null);
  assert.equal(row.refundRatePct, null);
});

test('S303 — sort by cancel+refund desc', async (t) => {
  const tag = makeTag('s303d');
  const paket = await tempPaket(t, `${tag}-pkt`);
  const jem = await tempJemaah(t, `${tag}-jem`);
  const agen1 = await tempAgent(t, `${tag}-aaa`);
  const agen2 = await tempAgent(t, `${tag}-bbb`);

  // agen1: 3 bookings, 1 cancel.
  await makeBooking(paket, jem.jemaah.id, agen1.agent.id, 'CANCELLED');
  await makeBooking(paket, jem.jemaah.id, agen1.agent.id, 'BOOKED');
  await makeBooking(paket, jem.jemaah.id, agen1.agent.id, 'BOOKED');
  // agen2: 4 bookings, 3 cancel.
  await makeBooking(paket, jem.jemaah.id, agen2.agent.id, 'CANCELLED');
  await makeBooking(paket, jem.jemaah.id, agen2.agent.id, 'CANCELLED');
  await makeBooking(paket, jem.jemaah.id, agen2.agent.id, 'CANCELLED');
  await makeBooking(paket, jem.jemaah.id, agen2.agent.id, 'BOOKED');

  const result = await getAgentCancelRefundRollup({ days: 90 });
  const idx1 = result.rows.findIndex((r) => r.agentSlug === agen1.agent.slug);
  const idx2 = result.rows.findIndex((r) => r.agentSlug === agen2.agent.slug);
  assert.ok(idx1 >= 0 && idx2 >= 0, 'both rows present');
  assert.ok(idx2 < idx1, 'agen2 (more cancels) sorts ahead of agen1');
});

test('S303 — totals.overallRatePct accumulates across agents', async (t) => {
  const tag = makeTag('s303e');
  const paket = await tempPaket(t, `${tag}-pkt`);
  const jem = await tempJemaah(t, `${tag}-jem`);
  const agen = await tempAgent(t, `${tag}-a`);

  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'CANCELLED');
  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'REFUNDED');
  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'BOOKED');
  await makeBooking(paket, jem.jemaah.id, agen.agent.id, 'BOOKED');

  const result = await getAgentCancelRefundRollup({ days: 90 });
  assert.ok(typeof result.totals.overallRatePct === 'number');
  assert.ok(result.totals.totalBookings > 0);
});

test('S303 — MIN_SAMPLE constant exported as 3', () => {
  assert.equal(MIN_SAMPLE, 3);
});
