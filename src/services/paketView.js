// Stage 48 — public paket landing visit tracker. Identifies a visitor
// via the non-httpOnly `rp_vis` cookie (32-hex random, 1-year max-age).
// Upserts on (paketId, visitorId, dayKey) so multi-refresh per day
// stays counted once. Mints the cookie on first visit.
//
// Read-only "trackers" don't gate access; rendering paket.ejs proceeds
// even if the upsert throws — the landing page is more important than
// the analytics signal.

import { randomBytes } from 'node:crypto';
import { db } from './../lib/db.js';

const VISITOR_COOKIE = 'rp_vis';
const COOKIE_MAX_AGE_MS = 365 * 86_400_000;

function localYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Resolve or mint the visitor cookie. Called from the route — caller
 * passes req + res so we can read existing cookie and set a new one.
 */
export function getOrSetVisitorId(req, res, { cookieSecure = false } = {}) {
  let id = req.cookies?.[VISITOR_COOKIE];
  if (!id || !/^[0-9a-f]{32}$/.test(id)) {
    id = randomBytes(16).toString('hex');
    res.cookie(VISITOR_COOKIE, id, {
      httpOnly: false,        // pageviews aren't sensitive; reading from JS later is fine
      sameSite: 'lax',
      secure: cookieSecure,
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
    });
  }
  return id;
}

/**
 * Record a paket landing view. Idempotent per (paketId, visitorId, day).
 * Returns the upsert result or null on error (caller can ignore).
 */
export async function recordPaketView({ paketId, visitorId, agentSlug = null, now = new Date() }) {
  if (!paketId || !visitorId) return null;
  const dayKey = localYmd(now);
  try {
    return await db.paketView.upsert({
      where: { paketId_visitorId_dayKey: { paketId, visitorId, dayKey } },
      create: { paketId, visitorId, dayKey, agentSlug },
      update: {}, // pure no-op on repeat visit within same day
    });
  } catch (err) {
    console.warn('[paketView] upsert failed:', err?.message || err);
    return null;
  }
}

/**
 * Conversion summary per ACTIVE paket over the last N days:
 *   - visits: unique (visitorId × day) rows
 *   - bookings: non-cancelled bookings created in the same window
 *   - conversionPct: bookings / visits × 100, rounded to 0.1
 *
 * Used by the admin overview "Konversi paket" panel.
 */
const ONE_DAY_MS = 86_400_000;

export async function getPaketConversion({ now = new Date(), days = 30, limit = 10 } = {}) {
  const start = new Date(now.getTime() - days * ONE_DAY_MS);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setTime(end.getTime() + ONE_DAY_MS); // include today

  const [viewsRaw, bookingsRaw, paket] = await Promise.all([
    db.paketView.groupBy({
      by: ['paketId'],
      where: { createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
    db.booking.groupBy({
      by: ['paketId'],
      where: {
        createdAt: { gte: start, lt: end },
        status: { notIn: ['CANCELLED', 'REFUNDED'] },
      },
      _count: { _all: true },
    }),
    db.paket.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true, slug: true, title: true, departureDate: true },
    }),
  ]);

  const viewsByPaket = new Map(viewsRaw.map((v) => [v.paketId, v._count._all]));
  const bookingsByPaket = new Map(bookingsRaw.map((b) => [b.paketId, b._count._all]));

  const rows = paket.map((p) => {
    const visits = viewsByPaket.get(p.id) || 0;
    const bookings = bookingsByPaket.get(p.id) || 0;
    const conversionPct = visits > 0
      ? Math.round((bookings / visits) * 1000) / 10
      : null;
    return { paket: p, visits, bookings, conversionPct };
  })
    .filter((r) => r.visits > 0 || r.bookings > 0)
    .sort((a, b) => b.visits - a.visits)
    .slice(0, limit);

  return {
    rows,
    window: { days, start: localYmd(start), end: localYmd(end) },
    totals: {
      visits: rows.reduce((s, r) => s + r.visits, 0),
      bookings: rows.reduce((s, r) => s + r.bookings, 0),
    },
  };
}
