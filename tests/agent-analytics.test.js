// getPerPaketPerformance + getKomisiMonthly — agent-scoped, math correct,
// month buckets aligned. These power the new Analitik panels on /agen.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, fakeReq, systemActor } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { recordPayment } from '../src/services/payment.js';
import { getPerPaketPerformance, getKomisiMonthly } from '../src/services/analytics.js';

const ctx = { req: fakeReq, actor: systemActor };

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
    await db.komisiPayout.deleteMany({ where: { agentId: u.agent.id } });
    await db.booking.updateMany({ where: { agentId: u.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: u.agent.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });
  return u;
}

async function tempBooking(t, { paket, jemaah, agentId, totalAmount = '10000000', status = 'PENDING' }) {
  const bk = await db.booking.create({
    data: {
      bookingNo: `RP-${makeTag('bk').slice(0, 20)}`,
      paketId: paket.id, jemaahId: jemaah.id, agentId,
      kelas: 'QUAD', paxCount: 1, totalAmount, paidAmount: '0', status,
    },
  });
  t.after(async () => {
    await db.payment.deleteMany({ where: { bookingId: bk.id } });
    await db.komisi.deleteMany({ where: { bookingId: bk.id } });
    await db.booking.deleteMany({ where: { id: bk.id } });
  });
  return bk;
}

describe('getPerPaketPerformance', () => {
  test('returns [] for an agent with no bookings', async (t) => {
    const tag = makeTag('perpkt-empty');
    const agent = await tempAgent(t, tag);
    const rows = await getPerPaketPerformance(agent.agent.id);
    assert.deepEqual(rows, []);
  });

  test('groups by paket, sums LUNAS revenue, computes conversionPct', async (t) => {
    const tag = makeTag('perpkt-group');
    const agent = await tempAgent(t, tag);
    const jem = await tempJemaah(t, tag);
    const paketA = await tempPaket(t, `pktA-${tag}`);
    const paketB = await tempPaket(t, `pktB-${tag}`);
    // paketA: 3 bookings, 2 LUNAS → 67% conv, 20M revenue
    await tempBooking(t, { paket: paketA, jemaah: jem.jemaah, agentId: agent.agent.id, status: 'LUNAS', totalAmount: '10000000' });
    await tempBooking(t, { paket: paketA, jemaah: jem.jemaah, agentId: agent.agent.id, status: 'LUNAS', totalAmount: '10000000' });
    await tempBooking(t, { paket: paketA, jemaah: jem.jemaah, agentId: agent.agent.id, status: 'DP_PAID' });
    // paketB: 1 booking, CANCELLED → 0% conv, 0 revenue
    await tempBooking(t, { paket: paketB, jemaah: jem.jemaah, agentId: agent.agent.id, status: 'CANCELLED' });

    const rows = await getPerPaketPerformance(agent.agent.id);
    assert.equal(rows.length, 2);
    // Sorted by lunasRevenue desc — paketA first
    assert.equal(rows[0].slug, paketA.slug);
    assert.equal(rows[0].totalBookings, 3);
    assert.equal(rows[0].lunasCount, 2);
    assert.equal(rows[0].hotCount, 1, 'DP_PAID counts as hot');
    assert.equal(rows[0].lunasRevenue, 20_000_000);
    assert.equal(rows[0].conversionPct, 67);
    assert.equal(rows[1].slug, paketB.slug);
    assert.equal(rows[1].cancelledCount, 1);
    assert.equal(rows[1].lunasRevenue, 0);
    assert.equal(rows[1].conversionPct, 0);
  });

  test('respects agent scope — other agents do not appear', async (t) => {
    const tag = makeTag('perpkt-scope');
    const agentA = await tempAgent(t, `${tag}-a`);
    const agentB = await tempAgent(t, `${tag}-b`);
    const jem = await tempJemaah(t, tag);
    const paket = await tempPaket(t, `pkt-${tag}`);
    await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agentA.agent.id, status: 'LUNAS' });
    await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agentB.agent.id, status: 'LUNAS' });

    const rowsA = await getPerPaketPerformance(agentA.agent.id);
    assert.equal(rowsA.length, 1);
    assert.equal(rowsA[0].lunasCount, 1, 'A sees only own bookings');
  });

  test('limit caps the result; limit=0 unbounded', async (t) => {
    const tag = makeTag('perpkt-lim');
    const agent = await tempAgent(t, tag);
    const jem = await tempJemaah(t, tag);
    // Three different paket, all with one LUNAS each
    for (let i = 0; i < 3; i++) {
      const p = await tempPaket(t, `pkt-${tag}-${i}`);
      await tempBooking(t, { paket: p, jemaah: jem.jemaah, agentId: agent.agent.id, status: 'LUNAS', totalAmount: String(1_000_000 * (i + 1)) });
    }
    const capped = await getPerPaketPerformance(agent.agent.id, { limit: 2 });
    assert.equal(capped.length, 2);
    const all = await getPerPaketPerformance(agent.agent.id, { limit: 0 });
    assert.equal(all.length, 3);
  });
});

describe('getKomisiMonthly', () => {
  test('returns N empty buckets when agent has no komisi yet', async (t) => {
    const tag = makeTag('km-empty');
    const agent = await tempAgent(t, tag);
    const rows = await getKomisiMonthly(agent.agent.id, { months: 6 });
    assert.equal(rows.length, 6);
    for (const r of rows) {
      assert.equal(r.earned, 0);
      assert.equal(r.paid, 0);
      assert.equal(r.pending, 0);
      assert.match(r.month, /^\d{4}-\d{2}$/);
    }
  });

  test('LUNAS payment lands in the current-month earned bucket', async (t) => {
    const tag = makeTag('km-earned');
    const agent = await tempAgent(t, tag);
    const jem = await tempJemaah(t, tag);
    const paket = await tempPaket(t, `pkt-${tag}`);
    await db.paket.update({ where: { id: paket.id }, data: { komisiRate: 0.06 } });
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id, totalAmount: '10000000' });
    await recordPayment({ ...ctx, bookingId: bk.id, amount: 10_000_000, method: 'TRANSFER', currency: 'IDR' });

    const rows = await getKomisiMonthly(agent.agent.id, { months: 6 });
    const now = new Date();
    const curKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const cur = rows.find((r) => r.month === curKey);
    assert.ok(cur, 'current month bucket present');
    assert.equal(cur.earned, 600_000, '6% × 10M lands as EARNED this month');
    assert.equal(cur.paid, 0, 'no payout yet');
  });

  test('CANCELLED komisi is excluded from buckets', async (t) => {
    const tag = makeTag('km-cancel');
    const agent = await tempAgent(t, tag);
    // Inject a CANCELLED komisi row directly — would normally come from a
    // booking cancel after LUNAS. We just need the row shape.
    const jem = await tempJemaah(t, tag);
    const paket = await tempPaket(t, `pkt-${tag}`);
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    await db.komisi.create({
      data: {
        agentId: agent.agent.id, bookingId: bk.id,
        amount: '500000', currency: 'IDR',
        status: 'CANCELLED', earnedAt: new Date(),
      },
    });
    const rows = await getKomisiMonthly(agent.agent.id, { months: 6 });
    const total = rows.reduce((a, r) => a + r.earned + r.paid + r.pending, 0);
    assert.equal(total, 0, 'CANCELLED rows contribute nothing');
  });
});
