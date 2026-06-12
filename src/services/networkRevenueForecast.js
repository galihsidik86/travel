// Stage 251 — network-wide expected remaining revenue. Projects cash
// admin should expect to collect across all active paket using the
// same probability heuristic as the S99 agen commission forecast:
//
//   PENDING   0.30   (form submitted, no money yet — most fall through)
//   BOOKED    0.50   (jemaah committed but not paid — coin flip)
//   DP_PAID   0.70   (partial money down — usually completes)
//   PARTIAL   0.85   (multiple installments — strong signal)
//   LUNAS     1.00   (already in; remaining = 0 by definition)
//
// Distinct from S99 (per-agent komisi forecast) which projects commission
// liability. This one projects gross cash inflow from existing pipeline —
// useful for cash-flow planning ("can we cover hotel deposit next month?").
//
// Returns per-paket rows + per-status rollup + grand total. CANCELLED/
// REFUNDED + ARCHIVED + soft-deleted paket excluded.

import { db } from '../lib/db.js';
import { toNumber } from '../lib/format.js';

const STATUS_PROBABILITY = {
  PENDING:  0.30,
  BOOKED:   0.50,
  DP_PAID:  0.70,
  PARTIAL:  0.85,
  LUNAS:    1.00,
};
const ACTIVE_STATUSES = Object.keys(STATUS_PROBABILITY);

export async function getNetworkRevenueForecast({ now = new Date() } = {}) {
  const bookings = await db.booking.findMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      paket: {
        deletedAt: null,
        status: { not: 'ARCHIVED' },
        // Only future-departure paket — past trips' pipeline is moot
        departureDate: { gte: now },
      },
    },
    select: {
      id: true, status: true,
      totalAmount: true, paidAmount: true,
      paket: { select: { id: true, slug: true, title: true, departureDate: true } },
    },
  });

  if (bookings.length === 0) {
    return {
      totals: { remaining: 0, weightedExpected: 0, bookings: 0, paketCount: 0 },
      perStatus: ACTIVE_STATUSES.map((s) => ({ status: s, bookings: 0, remaining: 0, weightedExpected: 0, probability: STATUS_PROBABILITY[s] })),
      perPaket: [],
    };
  }

  // Aggregate
  const perStatusMap = new Map();   // status → {bookings, remaining, weightedExpected}
  const perPaketMap = new Map();    // paketId → {paket, bookings, remaining, weightedExpected}
  let totalRemaining = 0;
  let totalWeighted = 0;

  for (const b of bookings) {
    const total = toNumber(b.totalAmount) ?? 0;
    const paid = toNumber(b.paidAmount) ?? 0;
    const remaining = Math.max(0, total - paid);
    const prob = STATUS_PROBABILITY[b.status] ?? 0;
    const weighted = remaining * prob;

    if (!perStatusMap.has(b.status)) {
      perStatusMap.set(b.status, { bookings: 0, remaining: 0, weightedExpected: 0 });
    }
    const s = perStatusMap.get(b.status);
    s.bookings += 1;
    s.remaining += remaining;
    s.weightedExpected += weighted;

    if (b.paket?.id) {
      if (!perPaketMap.has(b.paket.id)) {
        perPaketMap.set(b.paket.id, {
          paket: {
            id: b.paket.id, slug: b.paket.slug,
            title: b.paket.title, departureDate: b.paket.departureDate,
          },
          bookings: 0, remaining: 0, weightedExpected: 0,
        });
      }
      const p = perPaketMap.get(b.paket.id);
      p.bookings += 1;
      p.remaining += remaining;
      p.weightedExpected += weighted;
    }

    totalRemaining += remaining;
    totalWeighted += weighted;
  }

  const perStatus = ACTIVE_STATUSES.map((status) => {
    const v = perStatusMap.get(status) || { bookings: 0, remaining: 0, weightedExpected: 0 };
    return {
      status,
      probability: STATUS_PROBABILITY[status],
      bookings: v.bookings,
      remaining: Math.round(v.remaining),
      weightedExpected: Math.round(v.weightedExpected),
    };
  });

  // Sort paket by departureDate asc (closest first) so admin sees
  // imminent cash flow needs at the top.
  const perPaket = [...perPaketMap.values()]
    .map((p) => ({
      paket: p.paket,
      bookings: p.bookings,
      remaining: Math.round(p.remaining),
      weightedExpected: Math.round(p.weightedExpected),
    }))
    .sort((a, b) => {
      const da = a.paket.departureDate ? new Date(a.paket.departureDate).getTime() : Infinity;
      const db_ = b.paket.departureDate ? new Date(b.paket.departureDate).getTime() : Infinity;
      return da - db_;
    });

  return {
    totals: {
      remaining: Math.round(totalRemaining),
      weightedExpected: Math.round(totalWeighted),
      bookings: bookings.length,
      paketCount: perPaketMap.size,
    },
    perStatus,
    perPaket,
  };
}
