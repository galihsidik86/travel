// Stage 167 — find recent active bookings by phone for the
// admin walk-in booking flow + the agen lead create flow. Surfaces
// a warning when an admin/agent is about to create what looks
// like a duplicate booking.
//
// Match strategy: digits-only normalisation (strip spaces/dashes/+62
// prefix, also leading zero) so "+62 822-3399-1100", "0822-33991100",
// and "62822339911 00" all collapse to the same key. Uses an endsWith
// SQL filter on last-8 digits for a cheap-ish DB pre-filter, then
// re-checks the full normalised form in JS. Mirrors the lead-
// reactivation hint pattern from S59.
//
// Window: 90 days by default. Long enough to catch "we just booked
// last month" but short enough that a paket from 2024 doesn't fire
// a warning when the same jemaah books a 2026 trip.

import { db } from '../lib/db.js';

const DEFAULT_WINDOW_DAYS = 90;

export function normalisePhone(phone) {
  if (!phone) return '';
  // Strip everything non-digit
  let d = String(phone).replace(/\D+/g, '');
  // 0xxx → 62xxx (Indonesian convention)
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d;
}

/**
 * Returns active bookings matching `phone` within `windowDays`.
 * Active = NOT IN (CANCELLED, REFUNDED) — cancelled bookings aren't
 * a real duplicate signal; the jemaah may be deliberately re-booking.
 *
 * Empty phone → empty result (no point asking the DB).
 * Too-short phone (≤4 digits) → empty result (would match too much).
 */
export async function findRecentBookingsByPhone({
  phone, windowDays = DEFAULT_WINDOW_DAYS, now = new Date(),
} = {}) {
  const norm = normalisePhone(phone);
  if (!norm || norm.length < 5) return [];
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60_000);
  // Cheap DB pre-filter: phone ends with the last 8 digits of the
  // normalised key. This is the same trick we use in S59 (lead
  // reactivation) to dodge format-mismatch false negatives.
  const tail = norm.slice(-8);
  const rows = await db.booking.findMany({
    where: {
      createdAt: { gte: cutoff },
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      jemaah: { phone: { endsWith: tail } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true, bookingNo: true, status: true, createdAt: true,
      kelas: true, paxCount: true, totalAmount: true,
      paket: { select: { slug: true, title: true, departureDate: true } },
      jemaah: { select: { fullName: true, phone: true } },
      agent: { select: { slug: true, displayName: true } },
    },
  });
  // Re-check the full normalised form in JS — the SQL endsWith might
  // catch a different jemaah whose phone happens to end the same way.
  return rows.filter((r) => normalisePhone(r.jemaah?.phone) === norm);
}

/**
 * Returns active leads matching `phone` within `windowDays`. Same
 * normalisation + filter rules as bookings. Used by the agen CRM
 * to warn before creating yet another lead for the same jemaah.
 * Excludes terminal statuses (CONVERTED + LOST) — those have
 * outcomes and shouldn't block re-engagement.
 */
export async function findRecentLeadsByPhone({
  phone, agentId, windowDays = DEFAULT_WINDOW_DAYS, now = new Date(),
} = {}) {
  const norm = normalisePhone(phone);
  if (!norm || norm.length < 5) return [];
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60_000);
  const tail = norm.slice(-8);
  const where = {
    createdAt: { gte: cutoff },
    status: { notIn: ['CONVERTED', 'LOST'] },
    deletedAt: null,
    phone: { endsWith: tail },
  };
  if (agentId) where.agentId = agentId;
  const rows = await db.lead.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true, fullName: true, phone: true, status: true,
      source: true, notes: true, createdAt: true, agentId: true,
      agent: { select: { slug: true, displayName: true } },
    },
  });
  return rows.filter((r) => normalisePhone(r.phone) === norm);
}

export { DEFAULT_WINDOW_DAYS };
