// Stage 23 — pre-departure readiness checklist per jemaah.
//
// Operationalises data we already have: jemaah identity + JemaahDocument
// rows + Booking.roomId. Turns "is everyone ready to fly" into a single
// dashboard the admin can scan H-30 / H-7 / H-1 before departure.
//
// 8 checks per booking, all booleans:
//   passportPresent   — jemaah.passportNo set
//   passportValid     — passportExpiry ≥ departureDate + 6 months
//                       (Saudi requires 6 months validity beyond travel)
//   visaUmroh         — VISA_UMROH doc status=VERIFIED
//   vaccineMeningitis — VACCINE_MENINGITIS doc status=VERIFIED
//   healthCert        — HEALTH_CERT doc status=VERIFIED
//   manasikCert       — MANASIK_CERT doc status=VERIFIED
//   roomAssigned      — booking.roomId not null
//   emergencyContact  — jemaah.emergencyContact non-empty
//
// score = (passed / 8) × 100 (rounded)
// tier  = score ≥ 100 → ready
//         score ≥  60 → partial
//                       else → critical
//
// Sort: critical first (worst score), then partial, then ready. Within
// same tier, score ascending so the very-worst lands at the top of the
// list — admin starts the follow-up from the most urgent.

import { db } from '../lib/db.js';
import { HttpError } from '../middleware/error.js';

const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;     // ~6 months for visa rule

// Doc-status check helper — returns the matching row's status or null.
function docStatus(documents, type) {
  const row = documents?.find((d) => d.type === type);
  return row?.status ?? null;
}

function computeRow(booking, departureDate) {
  const j = booking.jemaah;
  const docs = j.documents || [];

  const expiryDeadline = new Date(departureDate.getTime() + SIX_MONTHS_MS);

  const checks = {
    passportPresent:   !!j.passportNo,
    passportValid:     !!j.passportExpiry && j.passportExpiry >= expiryDeadline,
    visaUmroh:         docStatus(docs, 'VISA_UMROH') === 'VERIFIED',
    vaccineMeningitis: docStatus(docs, 'VACCINE_MENINGITIS') === 'VERIFIED',
    healthCert:        docStatus(docs, 'HEALTH_CERT') === 'VERIFIED',
    manasikCert:       docStatus(docs, 'MANASIK_CERT') === 'VERIFIED',
    roomAssigned:      !!booking.roomId,
    emergencyContact:  !!(j.emergencyContact && j.emergencyContact.trim()),
  };

  const total = Object.keys(checks).length;
  const passed = Object.values(checks).filter(Boolean).length;
  const score = Math.round((passed / total) * 100);
  const tier = score >= 100 ? 'ready' : score >= 60 ? 'partial' : 'critical';

  return {
    bookingId: booking.id,
    bookingNo: booking.bookingNo,
    kelas: booking.kelas,
    paxCount: booking.paxCount,
    jemaah: {
      id: j.id,
      fullName: j.fullName,
      phone: j.phone,
      passportNo: j.passportNo,
      passportExpiry: j.passportExpiry,
      emergencyContact: j.emergencyContact,
    },
    room: booking.room ? { roomNo: booking.room.roomNo, floor: booking.room.floor } : null,
    checks, total, passed, score, tier,
  };
}

export async function getPreDepartureChecklist(paketSlug) {
  const paket = await db.paket.findUnique({
    where: { slug: paketSlug, deletedAt: null },
    select: {
      id: true, slug: true, title: true, departureDate: true, durationDays: true,
    },
  });
  if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');

  const bookings = await db.booking.findMany({
    where: {
      paketId: paket.id,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    },
    select: {
      id: true, bookingNo: true, kelas: true, paxCount: true, roomId: true,
      jemaah: {
        select: {
          id: true, fullName: true, phone: true,
          passportNo: true, passportExpiry: true, emergencyContact: true,
          documents: { select: { type: true, status: true } },
        },
      },
      room: { select: { roomNo: true, floor: true } },
    },
  });

  const rows = bookings.map((b) => computeRow(b, paket.departureDate));

  // critical first, then partial, then ready; within tier, score asc
  // (worst-of-worst at the very top of the list).
  const TIER_RANK = { critical: 0, partial: 1, ready: 2 };
  rows.sort((a, b) => {
    const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (t !== 0) return t;
    if (a.score !== b.score) return a.score - b.score;
    return (a.jemaah.fullName || '').localeCompare(b.jemaah.fullName || '');
  });

  const counts = {
    total: rows.length,
    ready: rows.filter((r) => r.tier === 'ready').length,
    partial: rows.filter((r) => r.tier === 'partial').length,
    critical: rows.filter((r) => r.tier === 'critical').length,
  };

  // Days until departure (rounded; negative if already past).
  const now = new Date();
  const daysToDeparture = Math.round((paket.departureDate.getTime() - now.getTime()) / 86_400_000);

  return { paket, rows, counts, daysToDeparture, generatedAt: now };
}
