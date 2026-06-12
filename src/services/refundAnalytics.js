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

/**
 * Stage 38 — drill-down: list every REFUNDED Payment row matching a paket
 * slug OR an agent slug in the same time window the panel uses. Returns the
 * Payment rows + each one's booking + jemaah identity so the admin can act
 * on individual leaks.
 *
 *   - paketSlug: filter by paket lineage
 *   - agentSlug: filter by agent; pass 'kantor-pusat' for walk-ins (no agent)
 *
 * Throws nothing on empty match — caller renders the "no refunds" state.
 */
export async function getRefundDetails({ paketSlug, agentSlug, days = 90, now = new Date() } = {}) {
  const { start, end } = resolveWindow(now, days);

  let paket = null;
  let agent = null;
  if (paketSlug) {
    paket = await db.paket.findUnique({
      where: { slug: paketSlug },
      select: { id: true, slug: true, title: true },
    });
  }
  if (agentSlug && agentSlug !== 'kantor-pusat') {
    agent = await db.agentProfile.findUnique({
      where: { slug: agentSlug },
      select: { id: true, slug: true, displayName: true },
    });
  }
  // Only require a match when the caller passed a non-sentinel slug
  if (paketSlug && !paket) return { paket: null, agent: null, rows: [], totals: null, window: { days } };
  if (agentSlug && agentSlug !== 'kantor-pusat' && !agent) {
    return { paket: null, agent: null, rows: [], totals: null, window: { days } };
  }

  const where = {
    status: 'REFUNDED',
    currency: 'IDR',
    createdAt: { gte: start, lt: end },
  };
  if (paket) where.booking = { ...(where.booking || {}), paketId: paket.id };
  if (agent) where.booking = { ...(where.booking || {}), agentId: agent.id };
  if (agentSlug === 'kantor-pusat') where.booking = { ...(where.booking || {}), agentId: null };

  const rows = await db.payment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, amount: true, createdAt: true, method: true, notes: true,
      booking: {
        select: {
          id: true, bookingNo: true, status: true, totalAmount: true,
          cancelReason: true,
          paket: { select: { slug: true, title: true } },
          jemaah: { select: { fullName: true, phone: true } },
          agent: { select: { slug: true, displayName: true } },
        },
      },
    },
  });

  const totalIdr = rows.reduce(
    (acc, r) => acc + Math.abs(toNumber(r.amount) ?? 0),
    0,
  );

  return {
    paket,
    agent: agent ?? (agentSlug === 'kantor-pusat'
      ? { slug: 'kantor-pusat', displayName: 'Kantor Pusat (walk-in)' }
      : null),
    rows: rows.map((r) => ({ ...r, amountAbs: Math.abs(toNumber(r.amount) ?? 0) })),
    totals: {
      count: rows.length,
      totalIdr,
    },
    window: {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
      days,
    },
  };
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
        // Stage 236 — pull the structured code so the per-reason rollup
        // can aggregate categories. NULL bucket renders as "(tanpa kode)".
        refundReasonCode: true,
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

  // Stage 236 — per-reason-code rollup. NULL refundReasonCode (legacy /
  // admin skipped the dropdown) buckets under `__UNSET__` sentinel; the
  // view renders it as "(tanpa kode)" so admin sees the categorisation
  // backlog at a glance.
  const reasonTotals = new Map();
  for (const r of refunds) {
    const refundAmt = Math.abs(toNumber(r.amount) ?? 0);
    const code = r.refundReasonCode || '__UNSET__';
    const row = reasonTotals.get(code) || { code, refunded: 0, refundCount: 0 };
    row.refunded += refundAmt;
    row.refundCount += 1;
    reasonTotals.set(code, row);
  }
  const perReasonCode = [...reasonTotals.values()]
    .map((r) => ({
      ...r,
      sharePct: totalRefunded > 0
        ? Math.round((r.refunded / totalRefunded) * 1000) / 10
        : null,
    }))
    // Sort by refunded desc, but __UNSET__ always at the end so the
    // categorised data dominates the visual ranking (mirrors S175).
    .sort((a, b) => {
      if (a.code === '__UNSET__' && b.code !== '__UNSET__') return 1;
      if (b.code === '__UNSET__' && a.code !== '__UNSET__') return -1;
      return b.refunded - a.refunded;
    });
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
    perReasonCode,
  };
}
