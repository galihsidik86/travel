// Komisi payout tests (5x). createPayout bundles all EARNED → PAID
// atomically, snapshots amount at write time, refuses on empty queue.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempUser, fakeReq } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { createPayout, listPayouts, getPayoutById } from '../src/services/payouts.js';

// Custom tempAgent (same as booking-admin.test.js but trimmed for this file)
async function tempAgent(t, tag) {
  const passwordHash = await hashPassword('test12345');
  const user = await db.user.create({
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
    await db.komisiPayout.deleteMany({ where: { agentId: user.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: user.agent.id } });
    await db.booking.updateMany({ where: { agentId: user.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

/**
 * Seed N EARNED komisi rows for an agent under one booking.
 * Returns the created rows so amount sums can be asserted exactly.
 */
async function seedEarned(t, { agentId, bookingId, amounts }) {
  const rows = [];
  for (const amt of amounts) {
    const k = await db.komisi.create({
      data: {
        bookingId, agentId, amount: String(amt), currency: 'IDR',
        status: 'EARNED', earnedAt: new Date(),
      },
    });
    rows.push(k);
  }
  return rows;
}

describe('createPayout — validation', () => {
  test('AGENT_NOT_FOUND on bogus agentId', async (t) => {
    const tag = makeTag('payout-noagent');
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    await assert.rejects(
      createPayout({
        req: fakeReq,
        actor: { id: admin.id, email: admin.email, role: admin.role },
        agentId: 'does-not-exist',
        method: 'TRANSFER',
      }),
      (err) => err.code === 'AGENT_NOT_FOUND',
    );
  });

  test('NO_EARNED_KOMISI when agent has zero EARNED rows', async (t) => {
    const tag = makeTag('payout-empty');
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const agent = await tempAgent(t, tag);
    await assert.rejects(
      createPayout({
        req: fakeReq,
        actor: { id: admin.id, email: admin.email, role: admin.role },
        agentId: agent.agent.id,
        method: 'TRANSFER',
      }),
      (err) => err.code === 'NO_EARNED_KOMISI',
    );
  });

  test('PENDING / PAID / CANCELLED komisi do NOT count toward "earned"', async (t) => {
    const tag = makeTag('payout-mixed-status');
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const agent = await tempAgent(t, tag);
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
        agentId: agent.agent.id, agentSlugCap: agent.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    // 3 non-EARNED rows → still nothing to disburse
    await db.komisi.createMany({ data: [
      { bookingId: booking.id, agentId: agent.agent.id, amount: '60000', currency: 'IDR', status: 'PENDING' },
      { bookingId: booking.id, agentId: agent.agent.id, amount: '60000', currency: 'IDR', status: 'PAID', paidAt: new Date() },
      { bookingId: booking.id, agentId: agent.agent.id, amount: '60000', currency: 'IDR', status: 'CANCELLED' },
    ] });
    await assert.rejects(
      createPayout({
        req: fakeReq,
        actor: { id: admin.id, email: admin.email, role: admin.role },
        agentId: agent.agent.id,
        method: 'TRANSFER',
      }),
      (err) => err.code === 'NO_EARNED_KOMISI',
    );
  });
});

describe('createPayout — happy path', () => {
  test('bundles all EARNED → PAID atomically; snapshot amount = sum at write', async (t) => {
    const tag = makeTag('payout-bundle');
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const agent = await tempAgent(t, tag);
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
        agentId: agent.agent.id, agentSlugCap: agent.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    // 3 EARNED rows summing to 180_000
    await seedEarned(t, {
      agentId: agent.agent.id, bookingId: booking.id,
      amounts: [60_000, 60_000, 60_000],
    });
    // Plus a CANCELLED + a PAID row that MUST NOT be bundled
    await db.komisi.create({
      data: { bookingId: booking.id, agentId: agent.agent.id, amount: '60000', currency: 'IDR', status: 'CANCELLED' },
    });
    await db.komisi.create({
      data: { bookingId: booking.id, agentId: agent.agent.id, amount: '60000', currency: 'IDR', status: 'PAID', paidAt: new Date() },
    });

    const { payout, komisiCount } = await createPayout({
      req: fakeReq,
      actor: { id: admin.id, email: admin.email, role: admin.role },
      agentId: agent.agent.id,
      method: 'TRANSFER',
      reference: 'BANK-TRX-001',
      notes: 'July payout',
    });
    assert.match(payout.payoutNo, /^PO-\d{4}-\d{5}$/, 'payoutNo format PO-YYYY-NNNNN');
    assert.equal(Number(payout.amount), 180_000, 'snapshot = sum of EARNED only');
    assert.equal(komisiCount, 3);
    assert.equal(payout.method, 'TRANSFER');
    assert.equal(payout.reference, 'BANK-TRX-001');
    assert.equal(payout.paidById, admin.id);

    // All 3 EARNED rows are now PAID + linked to the payout
    const all = await db.komisi.findMany({ where: { bookingId: booking.id }, orderBy: { createdAt: 'asc' } });
    const earnedBefore = all.filter((k) => k.status === 'PAID' && k.payoutId === payout.id);
    assert.equal(earnedBefore.length, 3, '3 newly-PAID rows linked to payout');

    // CANCELLED + previously-PAID untouched
    const otherPaid = all.find((k) => k.status === 'PAID' && k.payoutId !== payout.id);
    assert.ok(otherPaid, 'pre-existing PAID untouched');
    const cancelled = all.find((k) => k.status === 'CANCELLED');
    assert.equal(cancelled.payoutId, null, 'CANCELLED never linked');
  });

  test('post-payout call refuses (no more EARNED — idempotent guard)', async (t) => {
    const tag = makeTag('payout-twice');
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const agent = await tempAgent(t, tag);
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
        agentId: agent.agent.id, agentSlugCap: agent.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    await seedEarned(t, { agentId: agent.agent.id, bookingId: booking.id, amounts: [60_000] });

    await createPayout({
      req: fakeReq,
      actor: { id: admin.id, email: admin.email, role: admin.role },
      agentId: agent.agent.id, method: 'TRANSFER',
    });

    // 2nd call → all the EARNED rows are now PAID, so nothing to bundle
    await assert.rejects(
      createPayout({
        req: fakeReq,
        actor: { id: admin.id, email: admin.email, role: admin.role },
        agentId: agent.agent.id, method: 'TRANSFER',
      }),
      (err) => err.code === 'NO_EARNED_KOMISI',
    );
  });

  test('new EARNED komisi after payout can be bundled into a fresh payout', async (t) => {
    const tag = makeTag('payout-second');
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const agent = await tempAgent(t, tag);
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
        agentId: agent.agent.id, agentSlugCap: agent.agent.slug,
        kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });
    await seedEarned(t, { agentId: agent.agent.id, bookingId: booking.id, amounts: [60_000] });
    const p1 = await createPayout({
      req: fakeReq,
      actor: { id: admin.id, email: admin.email, role: admin.role },
      agentId: agent.agent.id, method: 'TRANSFER',
    });

    // Add NEW EARNED komisi
    await seedEarned(t, { agentId: agent.agent.id, bookingId: booking.id, amounts: [60_000, 30_000] });

    const p2 = await createPayout({
      req: fakeReq,
      actor: { id: admin.id, email: admin.email, role: admin.role },
      agentId: agent.agent.id, method: 'TRANSFER',
    });
    assert.notEqual(p2.payout.payoutNo, p1.payout.payoutNo, 'different payoutNo');
    assert.equal(Number(p2.payout.amount), 90_000, 'second payout sums only the new EARNED');
    assert.equal(p2.komisiCount, 2);
  });
});
