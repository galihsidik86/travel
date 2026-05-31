// Stage 22 — per-paket profitability (cost + komisi liability + net margin).
// Extends the cross-agen leaderboard introduced in admin-analytics.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempUser, fakeReq } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { recordPayment } from '../src/services/payment.js';
import { getPerPaketLeaderboard } from '../src/services/analytics.js';

const ctx = { req: fakeReq };

async function tempAgent(t, tag) {
  const passwordHash = await hashPassword('test12345');
  const u = await db.user.create({
    data: {
      email: `${tag}-agen@example.test`, passwordHash, role: 'AGEN',
      fullName: `Agent ${tag}`, phone: '+62811',
      agent: { create: {
        slug: `agent-${tag.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        displayName: `Agent ${tag}`, whatsapp: '+62811',
      } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.komisi.deleteMany({ where: { agentId: u.agent.id } });
    await db.booking.updateMany({ where: { agentId: u.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: u.agent.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });
  return u;
}

async function tempBooking(t, { paket, jemaah, agentId, totalAmount = '10000000', paxCount = 1 }) {
  const bk = await db.booking.create({
    data: {
      bookingNo: `RP-${makeTag('bk').slice(0, 20)}`,
      paketId: paket.id, jemaahId: jemaah.id, agentId,
      kelas: 'QUAD', paxCount,
      totalAmount, paidAmount: '0', status: 'PENDING',
    },
  });
  t.after(async () => {
    await db.payment.deleteMany({ where: { bookingId: bk.id } });
    await db.komisi.deleteMany({ where: { bookingId: bk.id } });
    await db.booking.deleteMany({ where: { id: bk.id } });
  });
  return bk;
}

async function setCost(paketId, costPerPaxIdr) {
  await db.paket.update({ where: { id: paketId }, data: { costPerPaxIdr } });
}

describe('per-paket profitability', () => {
  test('null costPerPaxIdr → margin fields null (no misleading 0% / 100%)', async (t) => {
    const tag = makeTag('prof-null');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const agent = await tempAgent(t, tag);
    const jem = await tempJemaah(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    await recordPayment({ ...ctx, actor: admin, bookingId: bk.id, amount: 10_000_000, method: 'TRANSFER', currency: 'IDR' });

    const rows = await getPerPaketLeaderboard();
    const ours = rows.find((r) => r.slug === paket.slug);
    assert.ok(ours);
    assert.equal(ours.costPerPaxIdr, null);
    assert.equal(ours.totalCostIdr, null);
    assert.equal(ours.netMarginIdr, null);
    assert.equal(ours.marginPct, null);
  });

  test('margin math: revenue − (paxCount × cost) − komisi liability', async (t) => {
    const tag = makeTag('prof-math');
    const paket = await tempPaket(t, `pkt-${tag}`);
    // 6% komisi rate, 8M cost per pax
    await db.paket.update({ where: { id: paket.id }, data: { komisiRate: 0.06 } });
    await setCost(paket.id, '8000000');
    const agent = await tempAgent(t, tag);
    const jem = await tempJemaah(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    // 2 LUNAS bookings × paxCount=1 × 10M = 20M revenue
    // Cost: 2 pax × 8M = 16M
    // Komisi liability: 2 × 6% × 10M = 1.2M (EARNED, status counts)
    // Net margin: 20M − 16M − 1.2M = 2.8M
    // Margin pct: 2.8M / 20M = 14%
    const bk1 = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    const bk2 = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    await recordPayment({ ...ctx, actor: admin, bookingId: bk1.id, amount: 10_000_000, method: 'TRANSFER', currency: 'IDR' });
    await recordPayment({ ...ctx, actor: admin, bookingId: bk2.id, amount: 10_000_000, method: 'TRANSFER', currency: 'IDR' });

    const rows = await getPerPaketLeaderboard();
    const ours = rows.find((r) => r.slug === paket.slug);
    assert.equal(ours.lunasPaxCount, 2);
    assert.equal(ours.lunasRevenue, 20_000_000);
    assert.equal(ours.costPerPaxIdr, 8_000_000);
    assert.equal(ours.totalCostIdr, 16_000_000);
    assert.equal(ours.komisiLiabilityIdr, 1_200_000);
    assert.equal(ours.netMarginIdr, 2_800_000);
    assert.equal(ours.marginPct, 14);
  });

  test('multi-pax booking scales cost by paxCount', async (t) => {
    const tag = makeTag('prof-pax');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await db.paket.update({ where: { id: paket.id }, data: { komisiRate: 0.05 } });
    await setCost(paket.id, '5000000');
    const jem = await tempJemaah(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    // 1 LUNAS × paxCount=4 × 8M = 32M revenue
    // Cost: 4 pax × 5M = 20M
    // Komisi (no agent): 0
    // Net: 32M − 20M − 0 = 12M
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, totalAmount: '32000000', paxCount: 4 });
    await recordPayment({ ...ctx, actor: admin, bookingId: bk.id, amount: 32_000_000, method: 'TRANSFER', currency: 'IDR' });

    const rows = await getPerPaketLeaderboard();
    const ours = rows.find((r) => r.slug === paket.slug);
    assert.equal(ours.lunasPaxCount, 4);
    assert.equal(ours.totalCostIdr, 20_000_000);
    assert.equal(ours.komisiLiabilityIdr, 0, 'walk-in booking has no komisi');
    assert.equal(ours.netMarginIdr, 12_000_000);
  });

  test('negative margin when cost > revenue is reported honestly', async (t) => {
    const tag = makeTag('prof-loss');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await setCost(paket.id, '15000000');  // 15M cost > 10M revenue per pax = loss
    const jem = await tempJemaah(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah });
    await recordPayment({ ...ctx, actor: admin, bookingId: bk.id, amount: 10_000_000, method: 'TRANSFER', currency: 'IDR' });

    const rows = await getPerPaketLeaderboard();
    const ours = rows.find((r) => r.slug === paket.slug);
    assert.equal(ours.netMarginIdr, -5_000_000, 'loss not masked');
    assert.equal(ours.marginPct, -50, 'negative pct surfaced');
  });

  test('CANCELLED + PENDING komisi excluded from liability', async (t) => {
    const tag = makeTag('prof-cancel');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await db.paket.update({ where: { id: paket.id }, data: { komisiRate: 0.10 } });
    await setCost(paket.id, '5000000');
    const agent = await tempAgent(t, tag);
    const jem = await tempJemaah(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    // 1 LUNAS → 1M EARNED komisi
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    await recordPayment({ ...ctx, actor: admin, bookingId: bk.id, amount: 10_000_000, method: 'TRANSFER', currency: 'IDR' });
    // Inject phantom CANCELLED + PENDING komisi rows; should NOT count
    await db.komisi.create({
      data: {
        agentId: agent.agent.id, bookingId: bk.id,
        amount: '999999', currency: 'IDR', status: 'CANCELLED',
      },
    });
    await db.komisi.create({
      data: {
        agentId: agent.agent.id, bookingId: bk.id,
        amount: '888888', currency: 'IDR', status: 'PENDING',
      },
    });

    const rows = await getPerPaketLeaderboard();
    const ours = rows.find((r) => r.slug === paket.slug);
    assert.equal(ours.komisiLiabilityIdr, 1_000_000, 'only EARNED counts (CANCELLED + PENDING excluded)');
  });
});
