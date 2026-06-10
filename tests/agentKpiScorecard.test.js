// Stage 171 — lifetime KPI scorecard for admin user-edit page.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getAgentKpiScorecard } from '../src/services/agentKpiScorecard.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: { create: { displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE', whatsapp: '+62811' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.lead.deleteMany({ where: { agentId: user.agent.id } });
    await db.komisiPayout.deleteMany({ where: { agentId: user.agent.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('getAgentKpiScorecard: empty agent → all-zero scorecard', async (t) => {
  const tag = makeTag('s171-empty');
  const u = await tempAgent(t, tag);
  const s = await getAgentKpiScorecard({ agentId: u.agent.id });
  assert.equal(s.counts.total, 0);
  assert.equal(s.counts.lunas, 0);
  assert.equal(s.conversionPct, null, 'null when no active bookings (no division by zero)');
  assert.equal(s.revenue, 0);
  assert.equal(s.lastBookingAt, null);
  assert.equal(s.komisi.lifetime, 0);
  assert.equal(s.leads.total, 0);
  assert.equal(s.topPaket.length, 0);
});

test('getAgentKpiScorecard: lunas + revenue + conversion math', async (t) => {
  const tag = makeTag('s171-math');
  const u = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);

  // 3 bookings: 1 LUNAS paid 500k, 1 PENDING, 1 CANCELLED
  const lunasBooking = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-LUNAS`, paketId: paket.id, jemaahId: jem.jemaah.id,
      agentId: u.agent.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '500000', paidAmount: '500000', status: 'LUNAS',
    },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-PEND`, paketId: paket.id, jemaahId: jem.jemaah.id,
      agentId: u.agent.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '500000', paidAmount: '0', status: 'PENDING',
    },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-CANC`, paketId: paket.id, jemaahId: jem.jemaah.id,
      agentId: u.agent.id,
      kelas: 'QUAD', paxCount: 1,
      totalAmount: '500000', paidAmount: '0', status: 'CANCELLED',
    },
  });

  const s = await getAgentKpiScorecard({ agentId: u.agent.id });
  assert.equal(s.counts.total, 3);
  assert.equal(s.counts.active, 2);
  assert.equal(s.counts.lunas, 1);
  assert.equal(s.counts.cancelled, 1);
  assert.equal(s.revenue, 500_000);
  // Conversion = lunas/active = 1/2 = 50%
  assert.equal(s.conversionPct, 50);
  assert.ok(s.lastBookingAt instanceof Date);
});

test('getAgentKpiScorecard: komisi sums per status', async (t) => {
  const tag = makeTag('s171-komisi');
  const u = await tempAgent(t, tag);
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  await db.komisi.create({
    data: { agentId: u.agent.id, bookingId: b.id, amount: '100000', currency: 'IDR', status: 'EARNED', earnedAt: new Date() },
  });
  await db.komisi.create({
    data: { agentId: u.agent.id, bookingId: b.id, amount: '200000', currency: 'IDR', status: 'PAID', earnedAt: new Date(), paidAt: new Date() },
  });
  await db.komisi.create({
    data: { agentId: u.agent.id, bookingId: b.id, amount: '50000', currency: 'IDR', status: 'CANCELLED', earnedAt: new Date() },
  });

  const s = await getAgentKpiScorecard({ agentId: u.agent.id });
  assert.equal(s.komisi.earned, 100_000);
  assert.equal(s.komisi.paid, 200_000);
  assert.equal(s.komisi.cancelled, 50_000);
  // lifetime = pending + earned + paid (NOT cancelled)
  assert.equal(s.komisi.lifetime, 300_000);
});

test('getAgentKpiScorecard: lead pipeline counted', async (t) => {
  const tag = makeTag('s171-leads');
  const u = await tempAgent(t, tag);
  await db.lead.create({
    data: { agentId: u.agent.id, fullName: 'C', phone: '0811', status: 'COLD', source: 'WA' },
  });
  await db.lead.create({
    data: { agentId: u.agent.id, fullName: 'W', phone: '0812', status: 'WARM', source: 'WA' },
  });
  await db.lead.create({
    data: { agentId: u.agent.id, fullName: 'X', phone: '0813', status: 'CONVERTED', source: 'WA' },
  });
  const s = await getAgentKpiScorecard({ agentId: u.agent.id });
  assert.equal(s.leads.total, 3);
  assert.equal(s.leads.cold, 1);
  assert.equal(s.leads.warm, 1);
  assert.equal(s.leads.converted, 1);
});

test('getAgentKpiScorecard: top paket ranked by revenue', async (t) => {
  const tag = makeTag('s171-top');
  const u = await tempAgent(t, tag);
  const p1 = await tempPaket(t, makeTag('s171-p1'));
  const p2 = await tempPaket(t, makeTag('s171-p2'));
  const jem = await tempJemaah(t, tag);
  // p2 has higher revenue
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`, paketId: p1.id, jemaahId: jem.jemaah.id,
      agentId: u.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '100000', paidAmount: '100000', status: 'LUNAS',
    },
  });
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-2`, paketId: p2.id, jemaahId: jem.jemaah.id,
      agentId: u.agent.id, kelas: 'QUAD', paxCount: 1,
      totalAmount: '500000', paidAmount: '500000', status: 'LUNAS',
    },
  });

  const s = await getAgentKpiScorecard({ agentId: u.agent.id });
  assert.equal(s.topPaket.length, 2);
  assert.equal(s.topPaket[0].slug, p2.slug, 'highest-revenue paket first');
  assert.equal(s.topPaket[0].revenue, 500_000);
  assert.equal(s.topPaket[1].slug, p1.slug);
});
