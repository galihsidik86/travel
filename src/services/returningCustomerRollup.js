// Stage 294 — admin overview per-month repeat-customer panel.
//
// "Repeat customer" for a given month = a LUNAS booking in that month
// from a jemaah who had AT LEAST ONE PRIOR LUNAS booking before that
// month started. We measure on `Booking.createdAt` (the moment they
// re-booked); using paket.departureDate would lag too long.
//
// CANCELLED/REFUNDED don't count toward either side — undone work
// isn't a real customer relationship.
//
// Window: trailing N months (default 6). Per-month row carries
// `{label, totalLunas, repeatLunas, repeatRatePct}`.

import { db } from '../lib/db.js';

const DEFAULT_MONTHS = 6;

function startOfMonth(d) {
  const x = new Date(d);
  x.setDate(1); x.setHours(0, 0, 0, 0);
  return x;
}

function monthLabel(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Returns `{months: [...], total: {lunas, repeat, ratePct}, sampleSize}`.
 * sampleSize = total LUNAS in window; ratePct = null if 0 to avoid
 * misleading "0%" reading.
 */
export async function getReturningCustomerRollup({ months = DEFAULT_MONTHS, now = new Date() } = {}) {
  // Build month boundaries: oldest → newest
  const windowEndExcl = startOfMonth(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  const windowStart = new Date(windowEndExcl);
  windowStart.setMonth(windowStart.getMonth() - months);

  // Pull all LUNAS bookings within and before the window to identify repeats
  const bookings = await db.booking.findMany({
    where: {
      status: 'LUNAS',
      createdAt: { lt: windowEndExcl },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, jemaahId: true, createdAt: true },
  });

  if (bookings.length === 0) {
    return { months: [], total: { lunas: 0, repeat: 0, ratePct: null }, sampleSize: 0 };
  }

  // Build per-jemaah "first LUNAS" timestamp via single pass
  const firstLunasAt = new Map();
  for (const b of bookings) {
    if (!firstLunasAt.has(b.jemaahId)) {
      firstLunasAt.set(b.jemaahId, b.createdAt);
    }
  }

  // Per-month buckets
  const buckets = new Map();
  for (let i = 0; i < months; i += 1) {
    const start = new Date(windowStart);
    start.setMonth(start.getMonth() + i);
    const label = monthLabel(start);
    buckets.set(label, { label, start, totalLunas: 0, repeatLunas: 0 });
  }

  for (const b of bookings) {
    const created = b.createdAt;
    if (created < windowStart) continue;
    const lbl = monthLabel(created);
    const bucket = buckets.get(lbl);
    if (!bucket) continue;
    bucket.totalLunas += 1;
    const first = firstLunasAt.get(b.jemaahId);
    // Repeat if jemaah's first LUNAS was strictly BEFORE this booking
    if (first && first.getTime() < b.createdAt.getTime()) {
      bucket.repeatLunas += 1;
    }
  }

  const rows = [...buckets.values()].map((r) => ({
    label: r.label,
    totalLunas: r.totalLunas,
    repeatLunas: r.repeatLunas,
    repeatRatePct: r.totalLunas === 0 ? null
      : Math.round((r.repeatLunas / r.totalLunas) * 1000) / 10,
  }));

  const totalLunas = rows.reduce((acc, r) => acc + r.totalLunas, 0);
  const totalRepeat = rows.reduce((acc, r) => acc + r.repeatLunas, 0);
  const totalRate = totalLunas === 0 ? null
    : Math.round((totalRepeat / totalLunas) * 1000) / 10;

  return {
    months: rows,
    total: { lunas: totalLunas, repeat: totalRepeat, ratePct: totalRate },
    sampleSize: totalLunas,
  };
}
