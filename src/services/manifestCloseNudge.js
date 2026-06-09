// Stage 141 — jemaah-side nudge for manifest close + missing docs.
//
// Triggers when ALL of:
//   - paket.manifestClosesAt set AND within `windowHours` of now (default 72h)
//     OR already overdue (admin still hasn't closed/extended)
//   - booking is active (not CANCELLED/REFUNDED)
//   - booking has ≥1 required doc missing (passport / visa umroh /
//     vaksin meningitis VERIFIED + emergency contact present)
//   - booking.manifestCloseNotifiedAt is NULL (idempotency guard so a
//     daily cron doesn't pile up duplicate nudges)
//
// Per booking, ONE EMAIL + ONE WA (if recipient has both). Recipient
// is the jemaah profile's email/phone; recipientUserId set so the
// `/saya/notifications` inbox + unread badge pick it up when the
// jemaah is logged in.
//
// Paket without manifestClosesAt are ignored — admin chose "never
// close" or hasn't set the date yet. Both are valid signals to skip
// the nudge entirely.

import { db } from '../lib/db.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Stage 141 — find bookings on paket within `windowHours` of close
 * AND with missing required docs AND not yet nudged. Returns the row
 * shape the notify helper consumes.
 *
 * `requireDoc(doc, type)` returns true when the doc is **not** VERIFIED.
 * Required set is intentionally narrow — passport / visa umroh / vaksin
 * meningitis / emergency contact. Health cert / manasik cert / room
 * assignment are nice-to-haves and don't trigger a nudge alone.
 */
export async function getManifestCloseNudgeCandidates({
  now = new Date(), windowHours = 72,
} = {}) {
  const horizon = new Date(now.getTime() + windowHours * ONE_HOUR_MS);

  const paketRows = await db.paket.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      manifestClosesAt: { not: null, lt: horizon },
    },
    select: {
      id: true, slug: true, title: true,
      manifestClosesAt: true, departureDate: true,
      bookings: {
        where: {
          status: { notIn: ['CANCELLED', 'REFUNDED'] },
          manifestCloseNotifiedAt: null,
        },
        select: {
          id: true, bookingNo: true,
          jemaah: {
            select: {
              id: true, fullName: true, email: true, phone: true,
              userId: true,
              passportNo: true,
              emergencyContact: true,
              notifEmail: true, notifWa: true,
              documents: { select: { type: true, status: true } },
            },
          },
        },
      },
    },
  });

  const rows = [];
  for (const p of paketRows) {
    const ms = p.manifestClosesAt.getTime() - now.getTime();
    const hoursUntilClose = Math.round(ms / ONE_HOUR_MS);
    const overdue = ms < 0;
    for (const b of p.bookings) {
      const j = b.jemaah;
      if (!j) continue;
      const missing = computeMissingRequired(j);
      if (missing.length === 0) continue;
      rows.push({
        bookingId: b.id, bookingNo: b.bookingNo,
        jemaah: j,
        paket: {
          id: p.id, slug: p.slug, title: p.title,
          manifestClosesAt: p.manifestClosesAt,
          departureDate: p.departureDate,
        },
        hoursUntilClose, overdue,
        missing,
      });
    }
  }
  return {
    rows,
    windowHours,
    counts: { total: rows.length, overdue: rows.filter((r) => r.overdue).length },
  };
}

/**
 * Stage 141 — pure helper. Returns an array of human-readable Bahasa
 * labels for the missing required items. Empty array = everything is
 * present (no nudge fires).
 */
export function computeMissingRequired(jemaah) {
  const missing = [];
  if (!jemaah.passportNo) missing.push('Nomor paspor');
  const docs = jemaah.documents || [];
  const hasVerified = (type) => docs.some((d) => d.type === type && d.status === 'VERIFIED');
  if (!hasVerified('VISA_UMROH'))         missing.push('Visa umroh');
  if (!hasVerified('VACCINE_MENINGITIS')) missing.push('Sertifikat vaksin meningitis');
  if (!jemaah.emergencyContact || !jemaah.emergencyContact.trim()) {
    missing.push('Kontak darurat');
  }
  return missing;
}
