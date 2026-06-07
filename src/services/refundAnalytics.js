// Stage 35 — refund analytics. Answers "where is money leaking?" with
// two lenses (paket + agent) over the last 90 days by default.
//
// The metric we want is "refund rate" = refunded IDR / (PAID IDR for the
// same period). Pure "refund total" isn't useful by itself — a big paket
// will always show a bigger number — the *rate* is what tells the admin
// which paket / agent has a structural problem vs. one-off bad luck.
//
// Read-only; never writes. Same posture as other admin analytics services.

import { db } from './../lib/db.js';
import { toNumber } from './../lib/format.js';

const ONE_DAY_MS = 86_400_000;

function resolveWindow(now, days) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setTime(end.getTime() + ONE_DAY_MS); // include today
  const start = new Date(end.getTime() - days * ONE_DAY_MS);
  return { start, end };
}

export async function getRefundAnalytics({ now = new Date(), days = 90, limit = 10 } = {}) {
  const { start, end } = resolveWindow(now, days);

  // Pull PAID + REFUNDED payments in the window. PAID gives the denominator;
  // REFUNDED rows are stored as negative IDR (see /admin refund flow).
  const [payments, refunds] = await Promise.all([
    db.payment.findMany({
      where: {
        status: 'PAID',
        currency: 'IDR',
        paidAt: { gte: start, lt: end },
      },
      select: {
        amount: true,
        booking: {
          select: {
            paketId: true, agentId: true,
            paket: { select: { slug: true, title: true } },
            agent: { select: { slug: true, displayName: true } },
          },
        },
      },
    }),
    db.payment.findMany({
      where: {
        status: 'REFUNDED',
        currency: 'IDR',
        createdAt: { gte: start, lt: end },
      },
      select: {
        amount: true,
        booking: {
          select: {
            paketId: true, agentId: true,
            paket: { select: { slug: true, title: true } },
            agent: { select: { slug: true, displayName: true } },
          },
        },
      },
    }),
  ]);

  const paketTotals = new Map();   // paketId → {paid, refunded, paket}
  const agentTotals = new Map();   // agentId | '__kp__' → {paid, refunded, agent}

  function bucketAdd(map, key, meta, paid, refunded) {
    const row = map.get(key) || { paid: 0, refunded: 0, refundCount: 0, ...meta };
    row.paid += paid;
    row.refunded += refunded;
    if (refunded > 0) row.refundCount += 1;
    // Carry meta forward in case a later row has fresher data
    Object.assign(row, meta);
    map.set(key, row);
  }

  for (const p of payments) {
    const amt = toNumber(p.amount) ?? 0;
    if (p.booking?.paketId) {
      bucketAdd(paketTotals, p.booking.paketId,
        { paket: p.booking.paket },
        amt, 0);
    }
    const agentKey = p.booking?.agentId || '__kp__';
    const agentMeta = p.booking?.agentId
      ? { agent: p.booking.agent }
      : { agent: { slug: null, displayName: 'Kantor Pusat' } };
    bucketAdd(agentTotals, agentKey, agentMeta, amt, 0);
  }

  for (const r of refunds) {
    const refundAmt = Math.abs(toNumber(r.amount) ?? 0); // stored negative
    if (r.booking?.paketId) {
      bucketAdd(paketTotals, r.booking.paketId,
        { paket: r.booking.paket },
        0, refundAmt);
    }
    const agentKey = r.booking?.agentId || '__kp__';
    const agentMeta = r.booking?.agentId
      ? { agent: r.booking.agent }
      : { agent: { slug: null, displayName: 'Kantor Pusat' } };
    bucketAdd(agentTotals, agentKey, agentMeta, 0, refundAmt);
  }

  function rowsFrom(map) {
    return [...map.values()]
      .filter((r) => r.refunded > 0) // only rows where at least one refund landed
      .map((r) => ({
        ...r,
        refundRatePct: r.paid > 0 ? Math.round((r.refunded / r.paid) * 1000) / 10 : null,
      }))
      // Sort by absolute refund (largest leak first) so the highest-impact
      // rows are visible without scrolling. Rate sort would surface tiny
      // paket with one tiny refund — not what the admin wants to see.
      .sort((a, b) => b.refunded - a.refunded)
      .slice(0, limit);
  }

  const paketRows = rowsFrom(paketTotals);
  const agentRows = rowsFrom(agentTotals);

  // Total leak across the whole window — header KPI
  const totalRefunded = refunds.reduce(
    (acc, r) => acc + Math.abs(toNumber(r.amount) ?? 0),
    0,
  );
  const totalPaid = payments.reduce(
    (acc, p) => acc + (toNumber(p.amount) ?? 0),
    0,
  );
  const overallRatePct = totalPaid > 0
    ? Math.round((totalRefunded / totalPaid) * 1000) / 10
    : null;

  return {
    window: {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10), // exclusive
      days,
    },
    totals: {
      paid: totalPaid,
      refunded: totalRefunded,
      ratePct: overallRatePct,
      refundCount: refunds.length,
    },
    perPaket: paketRows,
    perAgent: agentRows,
  };
}
