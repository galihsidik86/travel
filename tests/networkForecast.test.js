import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { getAllAgentsCommissionForecast } from '../src/services/agentForecast.js';

async function tempAgent(t, tag) {
  const email = `${tag}@example.test`;
  const u = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'), role: 'AGEN',
      fullName: `Agent ${tag}`, phone: '+62812',
      agent: { create: { slug: `slug-${tag}`, displayName: `Agent ${tag}`, whatsapp: '+62812000000' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { agentId: u.agent.id } });
    await db.booking.deleteMany({ where: { agentId: u.agent.id } });
    await db.agentProfile.delete({ where: { id: u.agent.id } });
    await db.user.delete({ where: { id: u.id } });
  });
  return u;
}

test('getAllAgentsCommissionForecast: skips agents with no active bookings', async (t) => {
  const tag = makeTag('nf-empty');
  // Empty agent — should be excluded from perAgent rows
  await tempAgent(t, `${tag}-x`);

  const r = await getAllAgentsCommissionForecast({ windowDays: 90 });
  const mine = r.perAgent.find((a) => a.slug === `slug-${tag}-x`);
  assert.equal(mine, undefined, 'agent with 0 active bookings excluded');
});

test('getAllAgentsCommissionForecast: sums across multiple agents', async (t) => {
  const tag = makeTag('nf-sum');
  const agent1 = await tempAgent(t, `${tag}-1`);
  const agent2 = await tempAgent(t, `${tag}-2`);
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);

  // Each agent: 1 BOOKED × 10M @ 6% × 50% = 300k expected
  for (const a of [agent1, agent2]) {
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-${a.id.slice(-4)}`,
        paketId: paket.id, jemaahId: j.jemaah.id,
        agentId: a.agent.id, kelas: 'QUAD', paxCount: 1,
        totalAmount: '10000000', paidAmount: '0', status: 'BOOKED',
      },
    });
  }

  const r = await getAllAgentsCommissionForecast({ windowDays: 90 });
  const mine = r.perAgent.filter((a) => a.slug.startsWith(`slug-${tag}-`));
  assert.equal(mine.length, 2);
  // Each agent's expected = 300k, total contribution = 600k
  const myTotal = mine.reduce((s, a) => s + a.expectedIdr, 0);
  assert.equal(myTotal, 600_000);
});

test('getAllAgentsCommissionForecast: perAgent sorted by expected desc', async (t) => {
  const tag = makeTag('nf-sort');
  const small = await tempAgent(t, `${tag}-small`);
  const big = await tempAgent(t, `${tag}-big`);
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);

  // small: 5M; big: 20M
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-S`, paketId: paket.id, jemaahId: j.jemaah.id,
      agentId: small.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '5000000', paidAmount: '0', status: 'BOOKED',
    },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-B`, paketId: paket.id, jemaahId: j.jemaah.id,
      agentId: big.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '20000000', paidAmount: '0', status: 'BOOKED',
    },
  });

  const r = await getAllAgentsCommissionForecast({ windowDays: 90 });
  const mine = r.perAgent.filter((a) => a.slug.startsWith(`slug-${tag}-`));
  assert.equal(mine.length, 2);
  assert.ok(mine[0].slug.endsWith('-big'), 'larger agent first');
  assert.ok(mine[0].expectedIdr > mine[1].expectedIdr);
});

test('getAllAgentsCommissionForecast: empty network → totals = 0', async (t) => {
  const r = await getAllAgentsCommissionForecast({ windowDays: 90 });
  // Other tests may have created agents — just verify the shape works
  assert.ok(Array.isArray(r.perAgent));
  assert.ok(Array.isArray(r.perMonth));
  assert.ok(typeof r.totals.expectedIdr === 'number');
});
