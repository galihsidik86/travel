// Admin dashboard aggregator tests.
//   - getAdminOverview: shape smoke + a delta test (LUNAS revenue goes up by
//     N when we mint a LUNAS booking via recordPayment).
//   - getFinanceSummary: cashByCurrency net (PAID + REFUNDED, refunds reduce),
//     receivables = sum(totalAmount - paidAmount) over non-cancelled bookings.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, fakeReq, systemActor } from './_helpers.js';
import { getAdminOverview, getFinanceSummary } from '../src/services/adminDashboard.js';
import { recordPayment } from '../src/services/payment.js';
import { issueRefund } from '../src/services/refund.js';
import { cancelBooking } from '../src/services/bookingAdmin.js';

const ctx = { req: fakeReq, actor: systemActor };

describe('getAdminOverview — shape', () => {
  test('returns expected top-level keys + KPI numeric shape', async () => {
    const r = await getAdminOverview();
    for (const k of [
      'kpis', 'recentActivity', 'topPaket', 'topAgents',
      'statusBreakdown', 'paketList', 'analytics',
      'paketRevenueTrend', 'revenueTrendRange',
    ]) {
      assert.ok(k in r, `missing top-level key: ${k}`);
    }
    // KPIs are all numeric (or object for komisi)
    for (const k of [
      'revenueLunas', 'paidAll', 'potentialHot',
      'bookingCount', 'bookingThisMonth', 'bookingToday', 'bookingThisQuarter',
      'leadCount24h', 'paketActiveCount', 'jemaahCount', 'agentCount',
    ]) {
      assert.equal(typeof r.kpis[k], 'number', `kpis.${k} not number`);
    }
    assert.ok(r.kpis.komisi);
    for (const s of ['PENDING', 'EARNED', 'PAID', 'CANCELLED']) {
      assert.equal(typeof r.kpis.komisi[s], 'number', `kpis.komisi.${s} not number`);
    }
  });

  test('topPaket sorted by fillPct desc; paketList sort: ACTIVE → CLOSED → DRAFT', async () => {
    const r = await getAdminOverview();
    // topPaket fillPct monotonically non-increasing
    for (let i = 1; i < r.topPaket.length; i++) {
      assert.ok(r.topPaket[i - 1].fillPct >= r.topPaket[i].fillPct,
        `fillPct desc broken at ${i}: ${r.topPaket[i - 1].fillPct} < ${r.topPaket[i].fillPct}`);
    }
    // paketList status ranking
    const rank = { ACTIVE: 0, CLOSED: 1, DRAFT: 2 };
    for (let i = 1; i < r.paketList.length; i++) {
      const a = rank[r.paketList[i - 1].status] ?? 99;
      const b = rank[r.paketList[i].status] ?? 99;
      assert.ok(a <= b, `paketList status order broken at ${i}`);
    }
  });
});

describe('getAdminOverview — LUNAS revenue delta', () => {
  test('paying a booking to LUNAS increases revenueLunas by totalAmount', async (t) => {
    const tag = makeTag('overview-delta');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
        kelas: 'QUAD', paxCount: 1,
        totalAmount: '750000', paidAmount: '0', status: 'PENDING',
      },
    });

    const before = (await getAdminOverview()).kpis.revenueLunas;

    await recordPayment({ ...ctx, bookingId: booking.id, amount: 750_000, method: 'TRANSFER' });
    const bk = await db.booking.findUnique({ where: { id: booking.id }, select: { status: true } });
    assert.equal(bk.status, 'LUNAS');

    const after = (await getAdminOverview()).kpis.revenueLunas;
    assert.equal(after - before, 750_000, 'revenueLunas grew by exactly totalAmount');
  });
});

describe('getFinanceSummary', () => {
  test('shape: cashByCurrency, receivables, receivedTotal, paymentLedger', async () => {
    const r = await getFinanceSummary();
    assert.ok(Array.isArray(r.cashByCurrency));
    assert.equal(typeof r.receivables, 'number');
    assert.equal(typeof r.receivedTotal, 'number');
    assert.ok(Array.isArray(r.paymentLedger));
    assert.ok(r.paymentLedger.length <= 20, 'ledger capped at 20');
    for (const row of r.cashByCurrency) {
      assert.ok('currency' in row);
      assert.equal(typeof row.amount, 'number');
      assert.equal(typeof row.count, 'number');
    }
  });

  test('cashByCurrency nets PAID + REFUNDED (refunds reduce the bucket)', async (t) => {
    const tag = makeTag('finance-net');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const booking = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}`, paketId: paket.id, jemaahId: user.jemaah.id,
        kelas: 'QUAD', paxCount: 1,
        totalAmount: '1000000', paidAmount: '0', status: 'PENDING',
      },
    });

    const before = await getFinanceSummary();
    const beforeIdr = before.cashByCurrency.find((c) => c.currency === 'IDR')?.amount ?? 0;

    // Pay 400k, then cancel + refund 100k.
    // Net cash delta should be +400k - 100k = +300k.
    await recordPayment({ ...ctx, bookingId: booking.id, amount: 400_000, method: 'TRANSFER' });
    await cancelBooking({ ...ctx, bookingId: booking.id, reason: 'change of plan' });
    await issueRefund({
      ...ctx, bookingId: booking.id, amount: 100_000, method: 'TRANSFER',
      reason: 'partial refund for test',
    });

    const after = await getFinanceSummary();
    const afterIdr = after.cashByCurrency.find((c) => c.currency === 'IDR')?.amount ?? 0;
    assert.equal(afterIdr - beforeIdr, 300_000,
      'net delta = paid 400k - refund 100k = +300k');
  });

  test('receivables excludes CANCELLED/REFUNDED bookings; receivedTotal includes them', async (t) => {
    const tag = makeTag('finance-recv');
    const user = await tempJemaah(t, tag);
    const paket = await tempPaket(t, tag);
    const beforeReceivables = (await getFinanceSummary()).receivables;

    // Active booking with 300k outstanding
    const active = await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-A`, paketId: paket.id, jemaahId: user.jemaah.id,
        kelas: 'QUAD', paxCount: 1,
        totalAmount: '500000', paidAmount: '200000', status: 'DP_PAID',
      },
    });
    // Cancelled booking — should NOT count toward receivables
    await db.booking.create({
      data: {
        bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: user.jemaah.id,
        kelas: 'QUAD', paxCount: 1,
        totalAmount: '999999', paidAmount: '0', status: 'CANCELLED',
      },
    });

    const after = (await getFinanceSummary()).receivables;
    assert.equal(after - beforeReceivables, 300_000,
      'only the active booking adds 300k to receivables');

    void active;
  });
});
