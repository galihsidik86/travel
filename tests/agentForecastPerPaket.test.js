// Stage 243 — per-paket commission forecast.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import { getAgentCommissionForecast } from '../src/services/agentForecast.js';
import { hashPassword } from '../src/lib/auth.js';

async function makeAgent(t, tag) {
  const email = `${tag}-agen@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'), role: 'AGEN',
      fullName: `Agen ${tag}`, phone: '+62811',
    },
  });
  const profile = await db.agentProfile.create({
    data: { userId: user.id, slug: tag, displayName: `Agen ${tag}`, whatsapp: '+62811' },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { agentId: profile.id } });
    await db.agentProfile.deleteMany({ where: { id: profile.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return { user, profile };
}

async function makeBooking(paket, jemaahId, agentId, totalAmount, status = 'BOOKED') {
  return db.booking.create({
    data: {
      bookingNo: `RP-${paket.slug}-${Math.random().toString(36).slice(2, 7)}`,
      paketId: paket.id, jemaahId, agentId,
      kelas: 'QUAD', paxCount: 1, totalAmount, paidAmount: '0', status,
    },
  });
}

test('getAgentCommissionForecast: returns perPaket array', async (t) => {
  const tag = makeTag('s243-shape');
  const { profile } = await makeAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await makeBooking(paket, u.jemaah.id, profile.id, '10000000', 'BOOKED');

  const r = await getAgentCommissionForecast({ agentId: profile.id });
  assert.ok(Array.isArray(r.perPaket));
  assert.equal(r.perPaket.length, 1);
  assert.equal(r.perPaket[0].paket.id, paket.id);
});

test('getAgentCommissionForecast: empty perPaket when no bookings', async (t) => {
  const tag = makeTag('s243-empty');
  const { profile } = await makeAgent(t, tag);
  const r = await getAgentCommissionForecast({ agentId: profile.id });
  assert.deepEqual(r.perPaket, []);
});

test('getAgentCommissionForecast: per-paket expected = sum of per-booking expected', async (t) => {
  const tag = makeTag('s243-sum');
  const { profile } = await makeAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  // 3 bookings on same paket — different status probabilities
  await makeBooking(paket, u.jemaah.id, profile.id, '10000000', 'BOOKED');   // 0.5
  await makeBooking(paket, u.jemaah.id, profile.id, '10000000', 'PARTIAL');  // 0.85
  await makeBooking(paket, u.jemaah.id, profile.id, '10000000', 'PENDING');  // 0.30

  const r = await getAgentCommissionForecast({ agentId: profile.id });
  assert.equal(r.perPaket.length, 1);
  // Default komisi rate 0.06 → expected per booking = totalAmount × rate × prob
  // Sum: 10M × 0.06 × (0.5 + 0.85 + 0.30) = 600k × 1.65 = 990k
  const expected = Math.round(10_000_000 * 0.06 * (0.5 + 0.85 + 0.30));
  assert.equal(r.perPaket[0].expectedIdr, expected);
  assert.equal(r.perPaket[0].bookings, 3);
});

test('getAgentCommissionForecast: perPaket sorted by expected DESC', async (t) => {
  const tag = makeTag('s243-sort');
  const { profile } = await makeAgent(t, tag);
  const paketSmall = await tempPaket(t, tag + '-small');
  const paketBig = await tempPaket(t, tag + '-big');
  const u = await tempJemaah(t, tag);
  await makeBooking(paketSmall, u.jemaah.id, profile.id, '5000000', 'BOOKED');
  await makeBooking(paketBig, u.jemaah.id, profile.id, '50000000', 'BOOKED');

  const r = await getAgentCommissionForecast({ agentId: profile.id });
  // Big paket should be first
  assert.equal(r.perPaket[0].paket.id, paketBig.id);
  assert.equal(r.perPaket[1].paket.id, paketSmall.id);
});

test('getAgentCommissionForecast: per-paket nested perStatus breakdown', async (t) => {
  const tag = makeTag('s243-status');
  const { profile } = await makeAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await makeBooking(paket, u.jemaah.id, profile.id, '5000000', 'BOOKED');
  await makeBooking(paket, u.jemaah.id, profile.id, '5000000', 'BOOKED');
  await makeBooking(paket, u.jemaah.id, profile.id, '5000000', 'DP_PAID');

  const r = await getAgentCommissionForecast({ agentId: profile.id });
  const p = r.perPaket[0];
  const booked = p.perStatus.find((s) => s.status === 'BOOKED');
  const dp = p.perStatus.find((s) => s.status === 'DP_PAID');
  assert.ok(booked);
  assert.equal(booked.bookings, 2);
  assert.ok(dp);
  assert.equal(dp.bookings, 1);
});

test('getAgentCommissionForecast: CANCELLED bookings excluded', async (t) => {
  const tag = makeTag('s243-cancel');
  const { profile } = await makeAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-c`, paketId: paket.id, jemaahId: u.jemaah.id, agentId: profile.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '5000000', paidAmount: '0', status: 'CANCELLED',
    },
  });
  const r = await getAgentCommissionForecast({ agentId: profile.id });
  assert.deepEqual(r.perPaket, []);
});

test('getAgentCommissionForecast: per-paket rate reflects effective resolution', async (t) => {
  const tag = makeTag('s243-rate');
  const { profile } = await makeAgent(t, tag);
  const paket = await tempPaket(t, tag);
  // Set paket-specific rate 10%
  await db.paket.update({ where: { id: paket.id }, data: { komisiRate: '0.1000' } });
  const u = await tempJemaah(t, tag);
  await makeBooking(paket, u.jemaah.id, profile.id, '10000000', 'BOOKED');

  const r = await getAgentCommissionForecast({ agentId: profile.id });
  assert.equal(r.perPaket[0].rate, 0.1);
});

test('getAgentCommissionForecast: existing fields unchanged (rows + perStatus + totals)', async (t) => {
  const tag = makeTag('s243-back-compat');
  const { profile } = await makeAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await makeBooking(paket, u.jemaah.id, profile.id, '10000000', 'BOOKED');

  const r = await getAgentCommissionForecast({ agentId: profile.id });
  // Existing API not broken
  assert.ok(Array.isArray(r.rows));
  assert.ok(Array.isArray(r.perStatus));
  assert.ok(r.totals);
  assert.equal(r.totals.bookings, 1);
});
