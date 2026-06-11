// Stage 211 — per-paket dietary roll-up CSV for the catering / hotel
// kitchen brief. Captures S210's per-jemaah dietary + dietaryNotes
// at the moment of export so the vendor PDF/CSV the kitchen prints
// is a frozen snapshot — later jemaah changes don't retroactively
// mutate yesterday's brief.
//
// Two sections in one file:
//   - Header summary line: per-category pax count (REGULAR=120; VEG=3; …)
//   - Per-jemaah list: one row per non-REGULAR jemaah with bookingNo,
//     name, kelas, room, dietary, notes. REGULAR rows excluded because
//     they're the default — kitchen only cares about the exceptions.
//
// Excludes CANCELLED/REFUNDED (already off the trip). UTF-8 BOM + RFC
// 4180 + CRLF matches the S138/S165/S168/S208 convention.

import { db } from '../lib/db.js';

const DIETARY_LABELS = {
  REGULAR: 'Reguler',
  VEGETARIAN: 'Vegetarian',
  HALAL_STRICT: 'Halal ketat',
  SOFT_TEXTURE: 'Tekstur lembut (lansia)',
  DIABETIC: 'Diabetes (rendah gula)',
  OTHER: 'Lainnya',
};

function esc(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function buildDietaryRollupCsv(paketSlug) {
  const paket = await db.paket.findUnique({
    where: { slug: paketSlug },
    select: { id: true, slug: true, title: true, departureDate: true },
  });
  if (!paket) return null;

  const bookings = await db.booking.findMany({
    where: {
      paketId: paket.id,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    },
    select: {
      id: true, bookingNo: true, kelas: true, paxCount: true,
      jemaah: {
        select: {
          fullName: true, phone: true,
          dietary: true, dietaryNotes: true,
        },
      },
      room: { select: { roomNo: true } },
    },
  });

  // Per-category pax tally (covers REGULAR too — the summary line
  // shows the kitchen "you have N standard meals to prepare").
  const tally = new Map();
  for (const b of bookings) {
    const d = b.jemaah?.dietary || 'REGULAR';
    tally.set(d, (tally.get(d) || 0) + (b.paxCount || 1));
  }

  // Filter to non-REGULAR for the per-jemaah list — REGULAR is the
  // silent majority, kitchen doesn't need a name list for the
  // standard meal. Sort by dietary code so all DIABETIC group
  // together, then by jemaah name within the group.
  const specials = bookings
    .filter((b) => (b.jemaah?.dietary || 'REGULAR') !== 'REGULAR')
    .sort((a, b) => {
      const da = a.jemaah.dietary || '';
      const db_ = b.jemaah.dietary || '';
      if (da !== db_) return da.localeCompare(db_);
      return (a.jemaah.fullName || '').localeCompare(b.jemaah.fullName || '');
    });

  const header = [
    'bookingNo', 'jemaahName', 'phone', 'kelas', 'paxCount', 'roomNo',
    'dietary', 'dietaryLabel', 'dietaryNotes',
  ];
  const lines = specials.map((b) => [
    b.bookingNo,
    b.jemaah.fullName,
    b.jemaah.phone || '',
    b.kelas,
    b.paxCount,
    b.room?.roomNo || '',
    b.jemaah.dietary,
    DIETARY_LABELS[b.jemaah.dietary] || b.jemaah.dietary,
    b.jemaah.dietaryNotes || '',
  ].map(esc).join(','));

  // Tally row — REGULAR first (the standard meal volume), then specials
  // in declaration order so the kitchen reads "120 standard, 3 veg, ..."
  const tallyParts = [
    `REGULAR=${tally.get('REGULAR') || 0}`,
    ...['VEGETARIAN', 'HALAL_STRICT', 'SOFT_TEXTURE', 'DIABETIC', 'OTHER']
      .filter((d) => tally.has(d))
      .map((d) => `${d}=${tally.get(d)}`),
  ].join('; ');
  const totalPax = bookings.reduce((acc, b) => acc + (b.paxCount || 1), 0);
  const specialPax = specials.reduce((acc, b) => acc + (b.paxCount || 1), 0);
  const footer = [
    '', 'TOTAL DIET KHUSUS', '', '', String(specialPax), '',
    `TOTAL PAX=${totalPax}`, '', tallyParts,
  ].map(esc).join(',');

  const csv = ['\ufeff' + header.join(','), ...lines, footer].join('\r\n');
  return {
    csv, paket,
    rowCount: specials.length,
    totalPax,
    specialPax,
    tally: Object.fromEntries(tally),
  };
}
