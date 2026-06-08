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
 * Stage 50 — deterministic A/B variant pick from the visitor cookie.
 * Parity of the first hex digit splits 50/50 across the visitor base.
 * Stable per visitor so refreshes never flicker between variants.
 */
export function pickHeroVariant(visitorId) {
  if (!visitorId || visitorId.length < 1) return 'A';
  const code = parseInt(visitorId[0], 16);
  return Number.isFinite(code) && code % 2 === 0 ? 'A' : 'B';
}

/**
 * Record a paket landing view. Idempotent per (paketId, visitorId, day).
 * Returns the upsert result or null on error (caller can ignore).
 *
 * Stage 50/51: `heroVariant` + `utm*` fields are written on CREATE
 * (first-touch attribution) but never overwritten on later visits —
 * if a visitor came via `utm_campaign=ramadhan` and then revisits
 * directly, the campaign tag stays on the first row that day.
 */
export async function recordPaketView({
  paketId, visitorId, agentSlug = null,
  heroVariant = null, utm = null,
  now = new Date(),
} = {}) {
  if (!paketId || !visitorId) return null;
  const dayKey = localYmd(now);
  try {
    return await db.paketView.upsert({
      where: { paketId_visitorId_dayKey: { paketId, visitorId, dayKey } },
      create: {
        paketId, visitorId, dayKey, agentSlug,
        heroVariant,
        utmSource:   utm?.source   ?? null,
        utmMedium:   utm?.medium   ?? null,
        utmCampaign: utm?.campaign ?? null,
      },
      update: {}, // pure no-op on repeat visit within same day
    });
  } catch (err) {
    console.warn('[paketView] upsert failed:', err?.message || err);
    return null;
  }
}

/**
 * Stage 49 — given a (paketId, visitorId), return attribution summary
 * the booking should snapshot at create time. Reads all rows for this
 * (paket × visitor), returns oldest createdAt as firstViewAt, count of
 * rows as viewCount, and pulls heroVariant + first non-null UTM from
 * any row (preferring oldest — the first-touch).
 *
 * Returns null when no rows exist (no attribution to write).
 */
export async function getVisitorAttribution({ paketId, visitorId } = {}) {
  if (!paketId || !visitorId) return null;
  const rows = await db.paketView.findMany({
    where: { paketId, visitorId },
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true, heroVariant: true,
      utmSource: true, utmMedium: true, utmCampaign: true,
    },
  });
  if (rows.length === 0) return null;
  // First-touch wins: oldest row's variant + UTM
  const first = rows[0];
  // But heroVariant might have changed if admin paused the A/B mid-flight —
  // prefer the most-recent non-null so the booking reflects what the
  // visitor actually saw on the converting visit.
  const lastWithVariant = [...rows].reverse().find((r) => r.heroVariant);
  return {
    firstViewAt: first.createdAt,
    viewCount: rows.length,
    heroVariant: lastWithVariant?.heroVariant ?? null,
    utmSource: first.utmSource,
    utmMedium: first.utmMedium,
    utmCampaign: first.utmCampaign,
  };
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

/**
 * Stage 50 — per-variant conversion breakdown for one paket. Used on
 * the paket edit page when variantB is configured so admin sees which
 * hero copy converts better. Window mirrors `getPaketConversion`.
 *
 * Returns:
 *   {
 *     A: { visits, bookings, conversionPct },
 *     B: { visits, bookings, conversionPct },
 *     winner: 'A' | 'B' | 'tie' | null,
 *   }
 *
 * winner=null when both variants have <30 visits combined (statistical
 * noise too high to declare a winner — admin should wait).
 */
export async function getPaketABBreakdown({ paketId, now = new Date(), days = 30 } = {}) {
  if (!paketId) return null;
  const start = new Date(now.getTime() - days * ONE_DAY_MS);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setTime(end.getTime() + ONE_DAY_MS);

  const [views, bookings] = await Promise.all([
    db.paketView.groupBy({
      by: ['heroVariant'],
      where: { paketId, createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
    db.booking.groupBy({
      by: ['heroVariant'],
      where: {
        paketId, createdAt: { gte: start, lt: end },
        status: { notIn: ['CANCELLED', 'REFUNDED'] },
      },
      _count: { _all: true },
    }),
  ]);

  const viewsByVariant = new Map(views.map((v) => [v.heroVariant || null, v._count._all]));
  const bookingsByVariant = new Map(bookings.map((b) => [b.heroVariant || null, b._count._all]));

  function pack(variant) {
    const visits = viewsByVariant.get(variant) || 0;
    const bks = bookingsByVariant.get(variant) || 0;
    return {
      visits, bookings: bks,
      conversionPct: visits > 0 ? Math.round((bks / visits) * 1000) / 10 : null,
    };
  }
  const A = pack('A');
  const B = pack('B');
  const totalVisits = A.visits + B.visits;
  let winner = null;
  // Declare a winner once combined sample passes 30 visits — below that
  // the noise dominates the signal and the call would be misleading.
  if (totalVisits >= 30 && A.conversionPct != null && B.conversionPct != null) {
    if (A.conversionPct > B.conversionPct) winner = 'A';
    else if (B.conversionPct > A.conversionPct) winner = 'B';
    else winner = 'tie';
  }
  return { A, B, winner, window: { days } };
}

/**
 * Stage 51 — UTM campaign breakdown across all paket for the window.
 * Groups visits + non-cancelled bookings by (utmSource, utmMedium,
 * utmCampaign). Rows with all 3 null are bucketed as "(direct/none)".
 * Sorted by visits desc; the admin sees which campaigns drove traffic
 * and which actually converted.
 */
export async function getUtmBreakdown({ now = new Date(), days = 30, limit = 15 } = {}) {
  const start = new Date(now.getTime() - days * ONE_DAY_MS);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setTime(end.getTime() + ONE_DAY_MS);

  const [views, bookings] = await Promise.all([
    db.paketView.groupBy({
      by: ['utmSource', 'utmMedium', 'utmCampaign'],
      where: { createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
    db.booking.groupBy({
      by: ['utmSource', 'utmMedium', 'utmCampaign'],
      where: {
        createdAt: { gte: start, lt: end },
        status: { notIn: ['CANCELLED', 'REFUNDED'] },
      },
      _count: { _all: true },
    }),
  ]);

  function key(s, m, c) {
    return `${s || ''}|${m || ''}|${c || ''}`;
  }
  const viewsByKey = new Map(views.map((v) => [key(v.utmSource, v.utmMedium, v.utmCampaign), v._count._all]));
  const bookingsByKey = new Map(bookings.map((b) => [key(b.utmSource, b.utmMedium, b.utmCampaign), b._count._all]));

  // Build a unified set of keys + meta
  const keys = new Set([...viewsByKey.keys(), ...bookingsByKey.keys()]);
  const meta = new Map();
  for (const v of views) meta.set(key(v.utmSource, v.utmMedium, v.utmCampaign), {
    source: v.utmSource, medium: v.utmMedium, campaign: v.utmCampaign,
  });
  for (const b of bookings) if (!meta.has(key(b.utmSource, b.utmMedium, b.utmCampaign))) {
    meta.set(key(b.utmSource, b.utmMedium, b.utmCampaign), {
      source: b.utmSource, medium: b.utmMedium, campaign: b.utmCampaign,
    });
  }

  const rows = [...keys].map((k) => {
    const { source, medium, campaign } = meta.get(k) || {};
    const visits = viewsByKey.get(k) || 0;
    const bks = bookingsByKey.get(k) || 0;
    const isDirect = !source && !medium && !campaign;
    return {
      source, medium, campaign,
      isDirect,
      label: isDirect
        ? '(direct / none)'
        : `${source || '—'} · ${medium || '—'}${campaign ? ` · ${campaign}` : ''}`,
      visits, bookings: bks,
      conversionPct: visits > 0 ? Math.round((bks / visits) * 1000) / 10 : null,
    };
  })
    .filter((r) => r.visits > 0 || r.bookings > 0)
    .sort((a, b) => b.visits - a.visits)
    .slice(0, limit);

  return { rows, window: { days } };
}
