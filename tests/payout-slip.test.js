// Stage 21 — payout slip service. Verifies shape, totals, and method label
// localisation for the printable accounting slip.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempUser, fakeReq } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { recordPayment } from '../src/services/payment.js';
import { createPayout, getPayoutSlip } from '../src/services/payouts.js';

const ctx = { req: fakeReq };

async function tempAgent(t, tag) {
  const passwordHash = await hashPassword('test12345');
  const u = await db.user.create({
    data: {
      email: `${tag}-agen@example.test`, passwordHash, role: 'AGEN',
      fullName: `Agent ${tag}`, phone: '+62811',
      agent: { create: {
        slug: `agent-${tag.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        displayName: `Agent ${tag}`, whatsapp: '+628111111',
      } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.komisiPayout.deleteMany({ where: { agentId: u.agent.id } });
    await db.komisi.deleteMany({ where: { agentId: u.agent.id } });
    await db.booking.updateMany({ where: { agentId: u.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: u.agent.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });
  return u;
}

async function tempBooking(t, { paket, jemaah, agentId, totalAmount = '10000000' }) {
  const bk = await db.booking.create({
    data: {
      bookingNo: `RP-${makeTag('bk').slice(0, 20)}`,
      paketId: paket.id, jemaahId: jemaah.id, agentId,
      kelas: 'QUAD', paxCount: 1, totalAmount, paidAmount: '0', status: 'PENDING',
    },
  });
  t.after(async () => {
    await db.payment.deleteMany({ where: { bookingId: bk.id } });
    await db.komisi.deleteMany({ where: { bookingId: bk.id } });
    await db.booking.deleteMany({ where: { id: bk.id } });
  });
  return bk;
}

describe('getPayoutSlip', () => {
  test('returns shape with totals + komisi breakdown', async (t) => {
    const tag = makeTag('slip');
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const agent = await tempAgent(t, tag);
    const paket = await tempPaket(t, `pkt-${tag}`);
    await db.paket.update({ where: { id: paket.id }, data: { komisiRate: 0.10 } });
    const jem = await tempJemaah(t, tag);

    // Two LUNAS → 2 EARNED komisi (10% × 10M = 1M each = 2M total)
    const bk1 = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    const bk2 = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    await recordPayment({ ...ctx, actor: admin, bookingId: bk1.id, amount: 10_000_000, method: 'TRANSFER', currency: 'IDR' });
    await recordPayment({ ...ctx, actor: admin, bookingId: bk2.id, amount: 10_000_000, method: 'TRANSFER', currency: 'IDR' });

    const result = await createPayout({
      ...ctx, actor: admin, agentId: agent.agent.id,
      method: 'TRANSFER', reference: 'BCA 1234567890', notes: 'Bulan ini',
    });
    const slip = await getPayoutSlip(result.payout.id);

    assert.equal(slip.payout.payoutNo, result.payout.payoutNo);
    assert.equal(slip.payout.agent.displayName, agent.agent.displayName);
    assert.equal(slip.payout.komisi.length, 2);
    assert.equal(slip.totals.amountIdr, 2_000_000);
    assert.equal(slip.totals.sumKomisi, 2_000_000, 'breakdown sums to payout total');
    assert.equal(slip.totals.komisiCount, 2);
    assert.equal(slip.methodLabel, 'Transfer bank', 'method label localised to ID');
    assert.ok(slip.generatedAt instanceof Date);
  });

  test('throws 404 on unknown payout id', async () => {
    await assert.rejects(
      () => getPayoutSlip('does-not-exist-xyz'),
      (err) => err.status === 404 && err.code === 'PAYOUT_NOT_FOUND',
    );
  });

  test('every supported method has a Bahasa label', async (t) => {
    const tag = makeTag('slip-labels');
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const agent = await tempAgent(t, tag);
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJemaah(t, tag);
    const bk = await tempBooking(t, { paket, jemaah: jem.jemaah, agentId: agent.agent.id });
    await recordPayment({ ...ctx, actor: admin, bookingId: bk.id, amount: 10_000_000, method: 'TRANSFER', currency: 'IDR' });

    // QRIS is intentionally the same enum + label (already a brand name),
    // so we just verify every method resolves to SOMETHING printable.
    const expectedLabels = {
      TRANSFER: 'Transfer bank',
      CASH: 'Tunai',
      EWALLET: 'E-wallet',
      QRIS: 'QRIS',
    };
    for (const [method, expected] of Object.entries(expectedLabels)) {
      await db.komisi.updateMany({
        where: { agentId: agent.agent.id, status: 'PAID' },
        data: { status: 'EARNED', payoutId: null, paidAt: null },
      });
      const r = await createPayout({
        ...ctx, actor: admin, agentId: agent.agent.id,
        method, reference: null, notes: null,
      });
      const slip = await getPayoutSlip(r.payout.id);
      assert.equal(slip.methodLabel, expected, `${method} label`);
    }
  });
});
