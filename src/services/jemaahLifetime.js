// Stage 292 — per-jemaah lifetime view. Aggregates all bookings under
// a JemaahProfile (and across siblings if the profile is merged from
// anonymous claims via S5p.2) into one rollup so admin sees "who is
// this person, how many trips, how much spent".
//
// Repeat-customer flag: ≥2 LUNAS bookings (the holy grail metric for
// umroh agencies). Refunded/cancelled bookings DON'T count toward
// repeat status — those are undone work, not real customer loyalty.
//
// The current JemaahProfile may also share a phone with OTHER profiles
// (anonymous booking flow keeps spawning fresh rows pre-claim). We
// surface those "sibling profiles by phone" so admin can decide
// whether to merge them via the existing S5p.2 claim flow.

import { db } from '../lib/db.js';

const ACTIVE_STATUSES = ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL', 'LUNAS'];

function n(v) {
  return Number(v?.toString?.() ?? v) || 0;
}

function normalisePhoneDigits(raw) {
  if (!raw) return '';
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d;
}

/**
 * Returns `{profile, bookings, totals, repeatFlag, siblingProfiles}`.
 * Returns null when the jemaah doesn't exist.
 *
 * `totals`:
 *   - tripCount       — bookings ever placed (any status, including cancelled)
 *   - lunasCount      — completed (paid in full + flew, in practice)
 *   - cancelledCount  — CANCELLED+REFUNDED
 *   - activeCount     — open bookings (PENDING/BOOKED/DP_PAID/PARTIAL/LUNAS)
 *   - lifetimeRevenueIdr — sum of totalAmount on LUNAS bookings (the
 *     honest "what this customer paid us" number)
 *   - lifetimePaidIdr  — sum of paidAmount on active bookings
 *
 * `repeatFlag` is true when `lunasCount >= 2`.
 */
export async function getJemaahLifetime(jemaahId) {
  if (!jemaahId) return null;

  const profile = await db.jemaahProfile.findUnique({
    where: { id: jemaahId },
    select: {
      id: true, fullName: true, phone: true, email: true,
      nik: true, passportNo: true, passportExpiry: true,
      birthDate: true, gender: true,
    },
  });
  if (!profile) return null;

  // All bookings under this profile id. Tied to jemaahId, not jemaahUserId,
  // so anonymous bookings claimed-after-the-fact still surface.
  const bookings = await db.booking.findMany({
    where: { jemaahId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, bookingNo: true, status: true,
      totalAmount: true, paidAmount: true, currency: true,
      kelas: true, paxCount: true,
      createdAt: true,
      paket: { select: { id: true, slug: true, title: true, departureDate: true, returnDate: true } },
      agent: { select: { id: true, slug: true, displayName: true } },
    },
  });

  let tripCount = 0;
  let lunasCount = 0;
  let cancelledCount = 0;
  let activeCount = 0;
  let lifetimeRevenueIdr = 0;
  let lifetimePaidIdr = 0;
  for (const b of bookings) {
    tripCount += 1;
    if (b.status === 'LUNAS') {
      lunasCount += 1;
      lifetimeRevenueIdr += n(b.totalAmount);
    } else if (b.status === 'CANCELLED' || b.status === 'REFUNDED') {
      cancelledCount += 1;
    }
    if (ACTIVE_STATUSES.includes(b.status)) {
      activeCount += 1;
      lifetimePaidIdr += n(b.paidAmount);
    }
  }

  // Siblings: other JemaahProfile rows sharing the normalised phone digits.
  // These are anonymous-booking residuals that the S5p.2 claim flow would
  // merge if the jemaah ever registers + claims. Limit to 5 for the panel.
  //
  // The DB stores phones in mixed formats (`0811-...`, `+62 811 ...`,
  // `0811...`), so we prefilter by raw-digit `contains` on the last 4
  // chars (cheap; survives any dash/space/+62 format), then JS-side
  // normalise to confirm an exact phone match.
  let siblingProfiles = [];
  if (profile.phone) {
    const norm = normalisePhoneDigits(profile.phone);
    if (norm.length >= 8) {
      const last4 = norm.slice(-4);
      const candidates = await db.jemaahProfile.findMany({
        where: {
          id: { not: profile.id },
          phone: { contains: last4 },
        },
        select: {
          id: true, fullName: true, phone: true,
          _count: { select: { bookings: true } },
        },
        take: 50,
      });
      siblingProfiles = candidates
        .filter((c) => normalisePhoneDigits(c.phone) === norm)
        .slice(0, 5);
    }
  }

  return {
    profile,
    bookings,
    totals: {
      tripCount,
      lunasCount,
      cancelledCount,
      activeCount,
      lifetimeRevenueIdr,
      lifetimePaidIdr,
    },
    repeatFlag: lunasCount >= 2,
    siblingProfiles,
  };
}
