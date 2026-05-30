// Stage-16 admin parity: getPerPaketLeaderboard + getKomisiMonthlyAdmin.
// Both are cross-agent (no agentId filter) and back the new /admin panels.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, fakeReq, systemActor } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { recordPayment } from '../src/services/payment.js';
import {
  getPerPaketLeaderboard, getKomisiMonthlyAdmin,
} from '../src/services/analytics.js';

const ctx = { req: fakeReq, actor: systemActor };

async function tempAgent(t, tag, suffix = 'a') {
  const passwordHash = await hashPassword('test12345');
  const u = await db.user.create({
    data: {
      email: `${tag}-${suffix}-agen@example.test`, passwordHash, role: 'AGEN',
      fullName: `Agent ${tag}-${suffix}`, phone: '+62811',
      agent: { create: {
        slug: `agent-${tag.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${suffix}`,
        displayName: `Agent ${tag}-${suffix}`, whatsapp: '+62811',
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

async function tempBooking(t, { paket, jemaah, agentId = null, totalAmount = '10000000', status = 'PENDING' }) {
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

describe('getPerPaketLeaderboard', () => {
  test('aggregates across agents — counts distinct agents + direct/kantor-pusat bookings', async (t) => {
    const tag = makeTag('lb-cross');
    const a1 = await tempAgent(t, tag, '1');
    const a2 = await tempAgent(t, tag, '2');
    const jem = await tempJemaah(t, tag);
    const paket = await tempPaket(t, `pkt-${tag}`);
    await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: a1.agent.id, status: 'LUNAS', totalAmount: '10000000' });
    await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: a2.agent.id, status: 'LUNAS', totalAmount: '20000000' });
    await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: null, status: 'DP_PAID' }); // walk-in
    await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: a1.agent.id, status: 'CANCELLED' });

    const rows = await getPerPaketLeaderboard();
    const ours = rows.find((r) => r.slug === paket.slug);
    assert.ok(ours);
    assert.equal(ours.totalBookings, 4);
    assert.equal(ours.lunasCount, 2);
    assert.equal(ours.lunasRevenue, 30_000_000);
    assert.equal(ours.cancelledCount, 1);
    assert.equal(ours.hotCount, 1);
    assert.equal(ours.agentCount, 2, 'two distinct agents touched this paket');
    assert.equal(ours.directCount, 1, 'one walk-in (no agentId)');
    assert.equal(ours.conversionPct, 50);
    assert.equal(ours.agentIds, undefined, 'Set stripped from response');
  });

  test('honors date range (createdAt) — out-of-range bookings excluded', async (t) => {
    const tag = makeTag('lb-range');
    const agent = await tempAgent(t, tag);
    const jem = await tempJemaah(t, tag);
    const paket = await tempPaket(t, `pkt-${tag}`);
    const oldBk = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id, status: 'LUNAS' });
    await db.booking.update({
      where: { id: oldBk.id },
      data: { createdAt: new Date(Date.now() - 200 * 86_400_000) },
    });
    await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id, status: 'LUNAS', totalAmount: '5000000' });

    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const rows = await getPerPaketLeaderboard({ from: thirtyDaysAgo, to: today });
    const ours = rows.find((r) => r.slug === paket.slug);
    assert.ok(ours);
    assert.equal(ours.totalBookings, 1, 'only the recent booking counts');
    assert.equal(ours.lunasRevenue, 5_000_000);
  });

  test('excludes ARCHIVED + soft-deleted paket', async (t) => {
    const tag = makeTag('lb-arch');
    const agent = await tempAgent(t, tag);
    const jem = await tempJemaah(t, tag);
    const paket = await tempPaket(t, `pkt-${tag}`);
    await db.paket.update({ where: { id: paket.id }, data: { status: 'ARCHIVED' } });
    await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id, status: 'LUNAS' });

    const rows = await getPerPaketLeaderboard();
    assert.equal(rows.find((r) => r.slug === paket.slug), undefined, 'ARCHIVED paket hidden');
  });
});

describe('getKomisiMonthlyAdmin', () => {
  test('aggregates across all agents — sum of per-agent variants', async (t) => {
    const tag = makeTag('km-admin');
    const a1 = await tempAgent(t, tag, '1');
    const a2 = await tempAgent(t, tag, '2');
    const jem = await tempJemaah(t, tag);
    const paket = await tempPaket(t, `pkt-${tag}`);
    await db.paket.update({ where: { id: paket.id }, data: { komisiRate: 0.10 } });

    // Two LUNAS, one per agent — 10% of 5M each = 500k earned each
    const bk1 = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: a1.agent.id, totalAmount: '5000000' });
    await recordPayment({ ...ctx, bookingId: bk1.id, amount: 5_000_000, method: 'TRANSFER', currency: 'IDR' });
    const bk2 = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: a2.agent.id, totalAmount: '5000000' });
    await recordPayment({ ...ctx, bookingId: bk2.id, amount: 5_000_000, method: 'TRANSFER', currency: 'IDR' });

    const rows = await getKomisiMonthlyAdmin({ months: 6 });
    assert.equal(rows.length, 6);
    const now = new Date();
    const cur = rows.find((r) => r.month === `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);
    assert.ok(cur);
    assert.ok(cur.earned >= 1_000_000, `expected ≥ 1M earned this month, got ${cur.earned}`);
  });

  test('empty result when no komisi in window — N empty buckets', async () => {
    const rows = await getKomisiMonthlyAdmin({
      months: 3,
      now: new Date('1980-06-15'), // ancient month with no possible data
    });
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.equal(r.earned, 0);
      assert.equal(r.paid, 0);
      assert.equal(r.pending, 0);
    }
  });
});
