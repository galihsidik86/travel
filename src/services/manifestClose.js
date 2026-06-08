// Stage 43 — manifest close countdown. Surfaces paket whose
// `manifestClosesAt` is either:
//   - within `urgentHours` of now (default 72h) — "tutup pekan ini"
//   - already past with kursi still available — admin probably forgot
//     to either extend or close booking; explicit "OVERDUE" badge
//
// Paket without manifestClosesAt are ignored (admin chose "never close"
// or hasn't set it yet — both are valid). Paket already at kursiTotal
// are also ignored (the close date is moot once full).

import { db } from './../lib/db.js';

const ONE_HOUR_MS = 60 * 60_000;

export async function getManifestClosing({ now = new Date(), urgentHours = 72 } = {}) {
  const horizon = new Date(now.getTime() + urgentHours * ONE_HOUR_MS);

  const candidates = await db.paket.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      manifestClosesAt: { not: null, lt: horizon },
    },
    select: {
      id: true, slug: true, title: true,
      manifestClosesAt: true, departureDate: true,
      kursiTotal: true, kursiTerisi: true,
    },
    orderBy: { manifestClosesAt: 'asc' },
  });

  const rows = candidates
    // Paket that already filled — closes-at is irrelevant
    .filter((p) => p.kursiTerisi < p.kursiTotal)
    .map((p) => {
      const ms = p.manifestClosesAt.getTime() - now.getTime();
      const hoursUntilClose = Math.round(ms / ONE_HOUR_MS);
      const overdue = ms < 0;
      const fillPct = p.kursiTotal === 0 ? 0
        : Math.round((p.kursiTerisi / p.kursiTotal) * 100);
      return {
        ...p,
        hoursUntilClose,        // negative when overdue
        overdue,
        seatsRemaining: p.kursiTotal - p.kursiTerisi,
        fillPct,
      };
    });

  return {
    rows,
    horizonHours: urgentHours,
    counts: {
      total: rows.length,
      overdue: rows.filter((r) => r.overdue).length,
      urgent: rows.filter((r) => !r.overdue).length,
    },
  };
}

/**
 * Extend `manifestClosesAt` by `hours` (default 24). Used by the
 * one-click "perpanjang 24 jam" button on the panel. Returns the
 * updated paket so the route can echo the new close time.
 */
export async function extendManifestClose({ slug, hours = 24, now = new Date() }) {
  const paket = await db.paket.findUnique({
    where: { slug },
    select: { id: true, manifestClosesAt: true },
  });
  if (!paket) return null;
  // If manifestClosesAt is null (admin set "never close"), start from now
  // so the new close-at is meaningful instead of silently ignored.
  const base = paket.manifestClosesAt && paket.manifestClosesAt > now
    ? paket.manifestClosesAt
    : now;
  const newClose = new Date(base.getTime() + hours * ONE_HOUR_MS);
  return db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: newClose },
    select: { id: true, slug: true, manifestClosesAt: true },
  });
}
