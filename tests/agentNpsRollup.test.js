// Stage 313 — per-agent NPS rollup tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { getAgentNpsRollup } from '../src/services/agentNpsRollup.js';

async function tempAgent(t, tag) {
  const user = await db.user.create({
    data: {
      email: `${tag}-ag@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: { create: { slug: `${tag}-slug`, displayName: `Agen ${tag}`, whatsapp: '+62811', tier: 'BRONZE' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.tripFeedback.deleteMany({ where: { booking: { agentId: user.agent.id } } });
    await db.payment.deleteMany({ where: { booking: { agentId: user.agent.id } } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.booking.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

async function pastPaket(t, tag) {
  const ret = new Date(Date.now() - 30 * 86_400_000);
  const dep = new Date(ret.getTime() - 10 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  t.after(async () => {
    await db.tripFeedback.deleteMany({ where: { paketId: paket.id } });
    await db.payment.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.komisi.deleteMany({ where: { booking: { paketId: paket.id } } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('S313 — empty envelope when agentId is null', async () => {
  const r = await getAgentNpsRollup({ agentId: null });
  assert.equal(r.total, 0);
  assert.equal(r.overall.npsPct, null);
  assert.deepEqual(r.perPaket, []);
});

test('S313 — only counts feedback on this agent\'s bookings', async (t) => {
  const tag = makeTag('s313a');
  const agen = await tempAgent(t, tag);
  const other = await tempAgent(t, `${tag}-other`);
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await pastPaket(t, `${tag}-pkt`);

  // 3 promoters on agen, 2 detractors on the OTHER agent.
  for (const score of [10, 9, 9]) {
    const b = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-A-${Math.random().toString(36).slice(2, 6)}`,
        paketId: paket.id, jemaahId: jem.jemaah.id, agentId: agen.agent.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
      },
    });
    await db.tripFeedback.create({ data: { bookingId: b.id, paketId: paket.id, score } });
  }
  for (const score of [3, 2]) {
    const b = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-B-${Math.random().toString(36).slice(2, 6)}`,
        paketId: paket.id, jemaahId: jem.jemaah.id, agentId: other.agent.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
      },
    });
    await db.tripFeedback.create({ data: { bookingId: b.id, paketId: paket.id, score } });
  }

  const r = await getAgentNpsRollup({ agentId: agen.agent.id });
  assert.equal(r.total, 3);
  assert.equal(r.overall.promoters, 3);
  assert.equal(r.overall.detractors, 0);
  assert.equal(r.overall.npsPct, 100);
});

test('S313 — perPaket low-sample marker when < 5', async (t) => {
  const tag = makeTag('s313b');
  const agen = await tempAgent(t, tag);
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await pastPaket(t, `${tag}-pkt`);

  // 2 feedback rows → lowSample
  for (let i = 0; i < 2; i++) {
    const b = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-${i}`,
        paketId: paket.id, jemaahId: jem.jemaah.id, agentId: agen.agent.id,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
      },
    });
    await db.tripFeedback.create({ data: { bookingId: b.id, paketId: paket.id, score: 8 } });
  }
  const r = await getAgentNpsRollup({ agentId: agen.agent.id });
  assert.equal(r.perPaket[0].lowSample, true);
  assert.equal(r.perPaket[0].npsPct, null);
});
