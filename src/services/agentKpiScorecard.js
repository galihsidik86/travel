// Stage 171 — agent lifetime KPI scorecard for admin user-edit
// page. One-shot read across Booking + Lead + Komisi + Payment for
// a single agent, returning a compact summary suitable for a panel.
//
// Goals:
//   - "How many bookings has this agent sold?"
//   - "What's their LUNAS conversion rate?"
//   - "Total komisi paid + outstanding?"
//   - "When was their last booking?"
//   - "Top paket by revenue?"
//
// All-time (no date range) — matches the question "what's this agent
// done overall?". Excludes CANCELLED/REFUNDED bookings from
// conversion math (undone work, not a real customer relationship).

import { db } from '../lib/db.js';

export async function getAgentKpiScorecard({ agentId }) {
  // Pull bookings + komisi + leads in parallel. Same agent → small N
  // queries, no risk of N+1 since each is a single roundtrip.
  const [bookings, komisi, leads] = await Promise.all([
    db.booking.findMany({
      where: { agentId },
      select: {
        id: true, status: true, totalAmount: true, paidAmount: true,
        kelas: true, paxCount: true, createdAt: true,
        paket: { select: { slug: true, title: true } },
      },
    }),
    db.komisi.findMany({
      where: { agentId },
      select: { amount: true, status: true },
    }),
    db.lead.findMany({
      where: { agentId, deletedAt: null },
      select: { status: true },
    }),
  ]);

  // Booking counts by status — excludes CANCELLED/REFUNDED from
  // "active" denominators so the conversion% reflects real outcomes.
  let total = 0, lunas = 0, active = 0, cancelled = 0;
  let revenue = 0; // sum of paidAmount on LUNAS rows
  let lastBookingAt = null;
  const perPaket = new Map();
  for (const b of bookings) {
    total += 1;
    if (b.status === 'CANCELLED' || b.status === 'REFUNDED') {
      cancelled += 1;
      continue;
    }
    active += 1;
    if (b.status === 'LUNAS') {
      lunas += 1;
      const paid = Number(b.paidAmount?.toString?.() ?? b.paidAmount) || 0;
      revenue += paid;
      const key = b.paket?.slug || '__none__';
      let row = perPaket.get(key);
      if (!row) {
        row = {
          slug: b.paket?.slug || null,
          title: b.paket?.title || '— (paket tidak ditemukan)',
          lunasCount: 0, revenue: 0,
        };
        perPaket.set(key, row);
      }
      row.lunasCount += 1;
      row.revenue += paid;
    }
    if (!lastBookingAt || b.createdAt > lastBookingAt) {
      lastBookingAt = b.createdAt;
    }
  }
  const conversionPct = active > 0 ? Math.round((lunas / active) * 1000) / 10 : null;

  // Komisi totals by status
  let komisiPending = 0, komisiEarned = 0, komisiPaid = 0, komisiCancelled = 0;
  for (const k of komisi) {
    const amt = Number(k.amount?.toString?.() ?? k.amount) || 0;
    if (k.status === 'PENDING') komisiPending += amt;
    else if (k.status === 'EARNED') komisiEarned += amt;
    else if (k.status === 'PAID') komisiPaid += amt;
    else if (k.status === 'CANCELLED') komisiCancelled += amt;
  }

  // Lead funnel — count by status. Helps admin see if the agent
  // actively works the pipeline or only converts walk-ins.
  let leadCold = 0, leadWarm = 0, leadConverted = 0, leadLost = 0;
  for (const l of leads) {
    if (l.status === 'COLD') leadCold += 1;
    else if (l.status === 'WARM') leadWarm += 1;
    else if (l.status === 'CONVERTED') leadConverted += 1;
    else if (l.status === 'LOST') leadLost += 1;
  }

  // Top 3 paket by revenue — gives admin a quick sense of the
  // agent's specialty (or where they over-rely).
  const topPaket = [...perPaket.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 3);

  return {
    counts: { total, active, lunas, cancelled },
    conversionPct,
    revenue,
    lastBookingAt,
    komisi: {
      pending: komisiPending,
      earned: komisiEarned,
      paid: komisiPaid,
      cancelled: komisiCancelled,
      lifetime: komisiPending + komisiEarned + komisiPaid,
    },
    leads: {
      cold: leadCold, warm: leadWarm,
      converted: leadConverted, lost: leadLost,
      total: leads.length,
    },
    topPaket,
  };
}
