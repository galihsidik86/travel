// Stage 247 — per-paket document expiry overview. Admin triage list
// of jemaah whose docs are expired or about to expire across all the
// paket's ACTIVE bookings. Surfaces in the admin manifest tab so admin
// can chase renewals before departure without scanning each jemaah
// individually.
//
// Bands:
//   EXPIRED  — expiresAt < now
//   URGENT   — expiresAt < now + 30d
//   WARNING  — expiresAt < now + 60d
//
// Excludes REJECTED + PENDING docs (REJECTED needs resubmission, not
// renewal; PENDING has no real expiry signal yet). VERIFIED + SUBMITTED
// + EXPIRED docs surface — these reflect actual jemaah credentials
// admin needs to act on.

import { db } from '../lib/db.js';

const ONE_DAY_MS = 86_400_000;

const RELEVANT_DOC_STATUS = new Set(['VERIFIED', 'SUBMITTED', 'EXPIRED']);

export function bandFor(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt).getTime();
  if (exp < now.getTime()) return 'EXPIRED';
  const daysLeft = (exp - now.getTime()) / ONE_DAY_MS;
  if (daysLeft < 30) return 'URGENT';
  if (daysLeft < 60) return 'WARNING';
  return null;
}

export async function getPaketDocOverview({ paketSlug, now = new Date() } = {}) {
  const paket = await db.paket.findUnique({
    where: { slug: paketSlug },
    select: { id: true, slug: true, title: true, departureDate: true },
  });
  if (!paket) return null;

  const cutoff60d = new Date(now.getTime() + 60 * ONE_DAY_MS);

  // Pull bookings → jemaah → docs where docs are EXPIRED or
  // close to expiry. Filter at the SQL layer to keep the result set
  // small even when a paket has 200+ jemaah.
  const bookings = await db.booking.findMany({
    where: {
      paketId: paket.id,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      jemaah: {
        documents: {
          some: {
            status: { in: ['VERIFIED', 'SUBMITTED', 'EXPIRED'] },
            expiresAt: { not: null, lte: cutoff60d },
          },
        },
      },
    },
    select: {
      id: true, bookingNo: true, kelas: true, paxCount: true,
      jemaah: {
        select: {
          id: true, fullName: true, phone: true,
          documents: {
            where: {
              status: { in: ['VERIFIED', 'SUBMITTED', 'EXPIRED'] },
              expiresAt: { not: null },
            },
            select: {
              id: true, type: true, status: true,
              expiresAt: true, refNumber: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Flatten + classify; one row per (jemaah, doc) when in band.
  const rows = [];
  for (const b of bookings) {
    const docs = b.jemaah?.documents || [];
    for (const d of docs) {
      if (!RELEVANT_DOC_STATUS.has(d.status)) continue;
      const band = bandFor(d.expiresAt, now);
      if (!band) continue;
      rows.push({
        bookingId: b.id,
        bookingNo: b.bookingNo,
        kelas: b.kelas,
        paxCount: b.paxCount,
        jemaah: { id: b.jemaah.id, fullName: b.jemaah.fullName, phone: b.jemaah.phone },
        document: {
          id: d.id, type: d.type, status: d.status,
          expiresAt: d.expiresAt, refNumber: d.refNumber,
        },
        band,
      });
    }
  }

  // Sort: EXPIRED first, then URGENT, then WARNING; within band,
  // oldest expiry first (closest to today = most urgent).
  const BAND_RANK = { EXPIRED: 0, URGENT: 1, WARNING: 2 };
  rows.sort((a, b) => {
    const ra = BAND_RANK[a.band] ?? 99;
    const rb = BAND_RANK[b.band] ?? 99;
    if (ra !== rb) return ra - rb;
    return new Date(a.document.expiresAt).getTime() - new Date(b.document.expiresAt).getTime();
  });

  // Counters for the panel header
  const counts = {
    expired: rows.filter((r) => r.band === 'EXPIRED').length,
    urgent: rows.filter((r) => r.band === 'URGENT').length,
    warning: rows.filter((r) => r.band === 'WARNING').length,
    total: rows.length,
  };

  return { paket, rows, counts };
}
