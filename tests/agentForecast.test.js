import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { getAgentCommissionForecast, STATUS_PROBABILITY } from '../src/services/agentForecast.js';

async function tempAgent(t, tag, { komisiRateOverride = null } = {}) {
  const email = `${tag}-agent@example.test`;
  const u = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'), role: 'AGEN',
      fullName: `Agent ${tag}`, phone: '+62812',
      agent: { create: { slug: `slug-${tag}`, displayName: `Agent ${tag}`, whatsapp: '+62812000000', komisiRateOverride } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { agentId: u.agent.id } });
    await db.agentPaketKomisi.deleteMany({ where: { agentId: u.agent.id } });
    await db.booking.deleteMany({ where: { agentId: u.agent.id } });
    await db.agentProfile.delete({ where: { id: u.agent.id } });
    await db.user.delete({ where: { id: u.id } });
  });
  return u;
}

test('getAgentCommissionForecast: empty result for agent with no bookings', async (t) => {
  const tag = makeTag('af-empty');
  const agent = await tempAgent(t, tag);

  const r = await getAgentCommissionForecast({ agentId: agent.agent.id });
  assert.deepEqual(r.rows, []);
  assert.equal(r.totals.bookings, 0);
  assert.equal(r.totals.expectedIdr, 0);
});

test('getAgentCommissionForecast: ignores LUNAS + CANCELLED + REFUNDED', async (t) => {
  const tag = makeTag('af-skip');
  const agent = await tempAgent(t, tag);
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  // Already-LUNAS booking → has real Komisi row, not a forecast
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: j.jemaah.id,
      agentId: agent.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '10000000', paidAmount: '10000000', status: 'LUNAS',
    },
  });
  // CANCELLED — excluded
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-2`, paketId: paket.id, jemaahId: j.jemaah.id,
      agentId: agent.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '10000000', paidAmount: '0', status: 'CANCELLED',
    },
  });

  const r = await getAgentCommissionForecast({ agentId: agent.agent.id });
  assert.equal(r.totals.bookings, 0);
});

test('getAgentCommissionForecast: probability heuristic applied per status', async (t) => {
  const tag = makeTag('af-prob');
  const agent = await tempAgent(t, tag);
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);  // default komisiRate=0.06

  // BOOKED × 50% probability × 10M total × 6% komisi = 300_000 expected
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-B`, paketId: paket.id, jemaahId: j.jemaah.id,
      agentId: agent.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '10000000', paidAmount: '0', status: 'BOOKED',
    },
  });

  const r = await getAgentCommissionForecast({ agentId: agent.agent.id });
  const bookedRow = r.perStatus.find((p) => p.status === 'BOOKED');
  // 10_000_000 × 0.06 × 0.5 = 300_000
  assert.equal(bookedRow.expectedIdr, 300_000);
  assert.equal(r.totals.expectedIdr, 300_000);
});

test('getAgentCommissionForecast: agent override rate beats paket rate', async (t) => {
  const tag = makeTag('af-override');
  // 10% override (vs default 6% on paket)
  const agent = await tempAgent(t, tag, { komisiRateOverride: '0.10' });
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);

  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-DP`, paketId: paket.id, jemaahId: j.jemaah.id,
      agentId: agent.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '10000000', paidAmount: '3000000', status: 'DP_PAID',
    },
  });

  // 10_000_000 × 0.10 × 0.70 (DP_PAID prob) = 700_000
  const r = await getAgentCommissionForecast({ agentId: agent.agent.id });
  assert.equal(r.totals.expectedIdr, 700_000);
});

test('getAgentCommissionForecast: AgentPaketKomisi matrix beats agent override', async (t) => {
  const tag = makeTag('af-matrix');
  const agent = await tempAgent(t, tag, { komisiRateOverride: '0.10' });
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);

  // Matrix says 15% for this specific paket
  await db.agentPaketKomisi.create({
    data: { agentId: agent.agent.id, paketId: paket.id, rate: '0.15' },
  });

  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-PT`, paketId: paket.id, jemaahId: j.jemaah.id,
      agentId: agent.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '10000000', paidAmount: '5000000', status: 'PARTIAL',
    },
  });

  // 10M × 0.15 × 0.85 = 1_275_000
  const r = await getAgentCommissionForecast({ agentId: agent.agent.id });
  assert.equal(r.totals.expectedIdr, 1_275_000);
});

test('getAgentCommissionForecast: per-month bucketing groups bookings by departure month', async (t) => {
  const tag = makeTag('af-month');
  const agent = await tempAgent(t, tag);
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);

  // Two bookings, same paket → same month bucket
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: paket.id, jemaahId: j.jemaah.id,
      agentId: agent.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '1000000', paidAmount: '0', status: 'BOOKED',
    },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-2`, paketId: paket.id, jemaahId: j.jemaah.id,
      agentId: agent.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '1000000', paidAmount: '0', status: 'BOOKED',
    },
  });

  const r = await getAgentCommissionForecast({ agentId: agent.agent.id, windowDays: 90 });
  assert.equal(r.totals.bookings, 2);
  // Single month bucket
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].bookings, 2);
});
