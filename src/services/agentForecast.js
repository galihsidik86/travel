// Stage 99 — agent commission forecast.
//
// Looks at the agent's NON-LUNAS, non-cancelled active bookings and
// projects expected komisi earnings using:
//
//   expected = totalAmount × resolveRate(agent, paket) × probability(status)
//
// where probability is a coarse heuristic:
//
//   PENDING   0.30   (form submitted, no money yet — most fall through)
//   BOOKED    0.50   (jemaah committed but not paid — coin flip)
//   DP_PAID   0.70   (partial money down — usually completes)
//   PARTIAL   0.85   (multiple installments — strong signal)
//
// Already-LUNAS bookings have a real Komisi row, not a forecast.
// CANCELLED/REFUNDED bookings are excluded.
//
// **Bookings without a departureDate within the window are bucketed
// into "unscheduled"** — admin still wants the total expected pipeline,
// even when paket dates are TBD.
//
// Rate resolution: same chain as payment.js (S22) — matrix > agent override
// > paket rate > DEFAULT. Keeping the logic local (not importing private
// helpers from payment.js) so this service remains independent.
import { db } from '../lib/db.js';

const DEFAULT_KOMISI_RATE = 0.06;
const STATUS_PROBABILITY = {
  PENDING:  0.30,
  BOOKED:   0.50,
  DP_PAID:  0.70,
  PARTIAL:  0.85,
};
const ACTIVE_STATUSES = Object.keys(STATUS_PROBABILITY);

function toNumber(d) {
  if (d == null) return null;
  return Number(d.toString());
}

function monthKey(date) {
  if (!date) return 'unscheduled';
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * @param {object} opts
 * @param {string} opts.agentId required
 * @param {number} [opts.windowDays=90] only count bookings whose departureDate
 *                                       falls within `now + windowDays`. 0 = no window.
 * @returns {Promise<{rows:[{month,bookings,expectedIdr}], totals, perStatus}>}
 */
export async function getAgentCommissionForecast({ agentId, windowDays = 90, now = new Date() } = {}) {
  if (!agentId) return { rows: [], totals: { bookings: 0, expectedIdr: 0 }, perStatus: [] };

  // Window: only departures up to N days out. Unscheduled bookings
  // (departureDate=null) are always included — admin wants the pipeline
  // signal regardless.
  const windowEnd = windowDays > 0
    ? new Date(now.getTime() + windowDays * 86_400_000)
    : null;

  const bookings = await db.booking.findMany({
    where: {
      agentId,
      status: { in: ACTIVE_STATUSES },
      ...(windowEnd ? { paket: { is: { departureDate: { lte: windowEnd } } } } : {}),
    },
    select: {
      id: true, bookingNo: true, status: true, totalAmount: true,
      paket: { select: { id: true, departureDate: true, komisiRate: true } },
    },
  });

  if (bookings.length === 0) {
    return {
      rows: [], totals: { bookings: 0, expectedIdr: 0 },
      perStatus: [],
      windowDays, agentId,
    };
  }

  // Resolve agent override + matrix overrides in batch
  const agent = await db.agentProfile.findUnique({
    where: { id: agentId },
    select: { komisiRateOverride: true },
  });
  const agentOverride = toNumber(agent?.komisiRateOverride);

  const distinctPaketIds = [...new Set(bookings.map((b) => b.paket?.id).filter(Boolean))];
  const matrixRows = distinctPaketIds.length > 0
    ? await db.agentPaketKomisi.findMany({
        where: { agentId, paketId: { in: distinctPaketIds } },
        select: { paketId: true, rate: true },
      })
    : [];
  const matrixByPaket = new Map(matrixRows.map((r) => [r.paketId, toNumber(r.rate)]));

  // Aggregate per (month, status)
  const byMonth = new Map();      // monthKey → { bookings:0, expectedIdr:0 }
  const byStatus = new Map();     // status → { bookings:0, expectedIdr:0 }
  let totalBookings = 0, totalExpected = 0;

  for (const b of bookings) {
    const matrix = matrixByPaket.get(b.paket?.id) ?? null;
    const paketRate = toNumber(b.paket?.komisiRate);
    const rate = matrix ?? agentOverride ?? paketRate ?? DEFAULT_KOMISI_RATE;
    const total = Number(b.totalAmount?.toString?.() ?? b.totalAmount) || 0;
    const prob = STATUS_PROBABILITY[b.status] ?? 0;
    const expected = total * rate * prob;

    const mk = monthKey(b.paket?.departureDate);
    if (!byMonth.has(mk)) byMonth.set(mk, { bookings: 0, expectedIdr: 0 });
    const m = byMonth.get(mk); m.bookings += 1; m.expectedIdr += expected;

    if (!byStatus.has(b.status)) byStatus.set(b.status, { bookings: 0, expectedIdr: 0 });
    const s = byStatus.get(b.status); s.bookings += 1; s.expectedIdr += expected;

    totalBookings += 1;
    totalExpected += expected;
  }

  const rows = Array.from(byMonth.entries())
    .map(([month, v]) => ({
      month,
      bookings: v.bookings,
      expectedIdr: Math.round(v.expectedIdr),
    }))
    // unscheduled last; otherwise chronological asc
    .sort((a, z) => {
      if (a.month === 'unscheduled') return 1;
      if (z.month === 'unscheduled') return -1;
      return a.month.localeCompare(z.month);
    });

  const perStatus = ACTIVE_STATUSES.map((status) => {
    const v = byStatus.get(status) || { bookings: 0, expectedIdr: 0 };
    return {
      status,
      probability: STATUS_PROBABILITY[status],
      bookings: v.bookings,
      expectedIdr: Math.round(v.expectedIdr),
    };
  });

  return {
    rows,
    perStatus,
    totals: { bookings: totalBookings, expectedIdr: Math.round(totalExpected) },
    windowDays,
    agentId,
  };
}

/**
 * Stage 100 — network-wide forecast rollup. Calls per-agent S99 for every
 * ACTIVE agent and aggregates. For N agents this is N round-trips to the
 * DB — fine at typical scale (≤50 agents), revisit if it grows.
 *
 * Returns:
 *   perAgent: [{ agentId, slug, displayName, bookings, expectedIdr }]
 *   perMonth: [{ month, bookings, expectedIdr }]   // grand-total per month
 *   totals:   { bookings, expectedIdr, agentCount }
 */
export async function getAllAgentsCommissionForecast({ windowDays = 90, now = new Date() } = {}) {
  const agents = await db.agentProfile.findMany({
    where: {
      user: { status: 'ACTIVE', deletedAt: null },
    },
    select: { id: true, slug: true, displayName: true },
    orderBy: { slug: 'asc' },
  });

  const perAgent = [];
  const monthAccum = new Map();   // month → { bookings, expectedIdr }
  let totalBookings = 0;
  let totalExpected = 0;
  let agentCount = 0;

  for (const a of agents) {
    const r = await getAgentCommissionForecast({ agentId: a.id, windowDays, now });
    if (r.totals.bookings === 0) continue;
    agentCount += 1;
    totalBookings += r.totals.bookings;
    totalExpected += r.totals.expectedIdr;
    perAgent.push({
      agentId: a.id,
      slug: a.slug,
      displayName: a.displayName,
      bookings: r.totals.bookings,
      expectedIdr: r.totals.expectedIdr,
    });
    for (const m of r.rows) {
      if (!monthAccum.has(m.month)) monthAccum.set(m.month, { bookings: 0, expectedIdr: 0 });
      const slot = monthAccum.get(m.month);
      slot.bookings += m.bookings;
      slot.expectedIdr += m.expectedIdr;
    }
  }

  // Sort: per-agent by expected desc (biggest first); per-month chronological
  perAgent.sort((a, z) => z.expectedIdr - a.expectedIdr);
  const perMonth = Array.from(monthAccum.entries())
    .map(([month, v]) => ({ month, bookings: v.bookings, expectedIdr: v.expectedIdr }))
    .sort((a, z) => {
      if (a.month === 'unscheduled') return 1;
      if (z.month === 'unscheduled') return -1;
      return a.month.localeCompare(z.month);
    });

  return {
    perAgent,
    perMonth,
    totals: { bookings: totalBookings, expectedIdr: totalExpected, agentCount },
    windowDays,
  };
}

export { STATUS_PROBABILITY, DEFAULT_KOMISI_RATE };
