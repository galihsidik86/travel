// Stage 244 — crew-facing dietary brief CSV. Same shape as the S211
// admin export (`buildDietaryRollupCsv`) but **scoped via crew
// assignment** — the route checks `PaketCrew(userId, paketId)` and
// 404s when the crew isn't on the paket (same anti-enumeration
// pattern as S5oo manifest access).
//
// Why a separate function (not just reusing S211): S211's contract is
// "admin downloads this", and the route is mounted under /admin with
// a 3-role gate. Adding a parallel crew-side variant keeps the access
// boundary explicit + lets the email batch (S213) and the crew CSV
// download stay independent if the format needs to diverge later.

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

/**
 * Builds the CSV if the crew is assigned to the paket. Returns:
 *   - `null` when paket not found (route → 404)
 *   - `{ notAssigned: true }` when crew not on paket (route → 404; same
 *     generic 404 as the manifest access pattern, no info leak)
 *   - `{ csv, paket, rowCount, totalPax, specialPax, tally }` on success
 */
export async function buildCrewDietaryCsv({ userId, paketSlug }) {
  const paket = await db.paket.findUnique({
    where: { slug: paketSlug },
    select: { id: true, slug: true, title: true, departureDate: true },
  });
  if (!paket) return null;

  const assignment = await db.paketCrew.findFirst({
    where: { userId, paketId: paket.id },
    select: { paketId: true },
  });
  if (!assignment) return { notAssigned: true };

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

  // Per-category pax tally — includes REGULAR so the kitchen sees
  // "120 standard meals + 3 special".
  const tally = new Map();
  for (const b of bookings) {
    const d = b.jemaah?.dietary || 'REGULAR';
    tally.set(d, (tally.get(d) || 0) + (b.paxCount || 1));
  }

  // Filter to non-REGULAR for the per-jemaah list — REGULAR is the
  // silent majority (mirrors S211).
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

  // Tally line — REGULAR first then non-REGULAR codes in fixed order
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
    totalPax, specialPax,
    tally: Object.fromEntries(tally),
  };
}
