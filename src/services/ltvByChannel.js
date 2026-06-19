// Stage 385 — LTV (Lifetime Value) by acquisition channel.
//
// For each acquisition channel (UTM source / agen / direct), computes:
//   - distinct jemaah count
//   - lifetime LUNAS revenue (sum of totalAmount across all LUNAS bookings)
//   - average revenue per jemaah (LTV)
//   - repeat rate (% of jemaah with ≥2 LUNAS bookings)
//
// "Channel" is derived from the FIRST booking's UTM/agent/direct attribution
// — first-touch wins, so a jemaah brought in by FB ads who later books
// directly still counts under fb. Mirrors S55 cohortRetention convention.
//
// Pure read aggregator over Booking. Min-sample guard at 5 jemaah per
// channel — anything below renders as `lowSample:true` (rates noisy).

import { db } from '../lib/db.js';

const MIN_SAMPLE = 5;

function channelFor(b) {
  if (b.utmSource) return `utm:${b.utmSource}`;
  if (b.agentSlugCap) return `agen:${b.agentSlugCap}`;
  return 'direct';
}

function channelLabel(key) {
  if (key === 'direct') return 'Direct / Walk-in';
  if (key.startsWith('utm:')) return `UTM: ${key.slice(4)}`;
  if (key.startsWith('agen:')) return `Agen: ${key.slice(5)}`;
  return key;
}

export async function getLtvByChannel({ months = 12, now = new Date() } = {}) {
  const cutoff = new Date(now.getFullYear(), now.getMonth() - months, 1);
  // Pull all non-cancelled bookings since cutoff — we need the FIRST
  // booking per jemaah for channel attribution, and LUNAS totals for LTV.
  // Order by jemaahId, then createdAt so we can collapse in JS without a
  // window function.
  const bookings = await db.booking.findMany({
    where: {
      createdAt: { gte: cutoff },
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      // jemaahId is NOT NULL on Booking — every booking spawns a profile.
    },
    select: {
      id: true, jemaahId: true, createdAt: true,
      status: true, totalAmount: true,
      utmSource: true, agentSlugCap: true,
    },
    orderBy: [{ jemaahId: 'asc' }, { createdAt: 'asc' }],
  });

  // Reduce: per-jemaah first-touch channel + LUNAS sum + LUNAS count.
  const perJemaah = new Map();
  for (const b of bookings) {
    if (!b.jemaahId) continue;
    let row = perJemaah.get(b.jemaahId);
    if (!row) {
      row = {
        jemaahId: b.jemaahId,
        firstAt: b.createdAt,
        channel: channelFor(b),
        lunasCount: 0,
        lunasRevenueIdr: 0,
      };
      perJemaah.set(b.jemaahId, row);
    }
    if (b.status === 'LUNAS') {
      row.lunasCount += 1;
      row.lunasRevenueIdr += Number(b.totalAmount?.toString?.() ?? b.totalAmount) || 0;
    }
  }

  // Per-channel rollup
  const perChannel = new Map();
  for (const row of perJemaah.values()) {
    let c = perChannel.get(row.channel);
    if (!c) {
      c = {
        channel: row.channel,
        label: channelLabel(row.channel),
        jemaahCount: 0,
        lunasJemaahCount: 0,
        repeatJemaahCount: 0,
        totalLunasRevenueIdr: 0,
        totalLunasBookings: 0,
      };
      perChannel.set(row.channel, c);
    }
    c.jemaahCount += 1;
    if (row.lunasCount >= 1) c.lunasJemaahCount += 1;
    if (row.lunasCount >= 2) c.repeatJemaahCount += 1;
    c.totalLunasRevenueIdr += row.lunasRevenueIdr;
    c.totalLunasBookings += row.lunasCount;
  }

  const rows = [...perChannel.values()].map((c) => ({
    ...c,
    avgRevenuePerJemaahIdr: c.jemaahCount > 0
      ? Math.round(c.totalLunasRevenueIdr / c.jemaahCount)
      : 0,
    // % of jemaah from this channel that ever LUNAS'd
    conversionRatePct: c.jemaahCount >= MIN_SAMPLE
      ? Math.round((c.lunasJemaahCount / c.jemaahCount) * 1000) / 10
      : null,
    repeatRatePct: c.lunasJemaahCount >= MIN_SAMPLE
      ? Math.round((c.repeatJemaahCount / c.lunasJemaahCount) * 1000) / 10
      : null,
    lowSample: c.jemaahCount < MIN_SAMPLE,
  })).sort((a, b) => b.totalLunasRevenueIdr - a.totalLunasRevenueIdr);

  // Grand totals (across all channels with non-zero jemaah)
  const totalJemaah = rows.reduce((s, r) => s + r.jemaahCount, 0);
  const totalLunasRevenue = rows.reduce((s, r) => s + r.totalLunasRevenueIdr, 0);

  return {
    months,
    minSample: MIN_SAMPLE,
    rows,
    totals: {
      channelCount: rows.length,
      jemaahCount: totalJemaah,
      lunasRevenueIdr: totalLunasRevenue,
      avgLtvIdr: totalJemaah > 0 ? Math.round(totalLunasRevenue / totalJemaah) : 0,
    },
  };
}

export { MIN_SAMPLE, channelFor, channelLabel };
