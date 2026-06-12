// Stage 253 — global admin search. One query across four entities
// (bookings, jemaah, paket, agen) so admin can jump from /admin/search
// (or the topbar autocomplete) to whichever entity matches.
//
// Match strategy:
//   - bookings   bookingNo contains `q` OR jemaah.fullName contains `q`
//   - jemaah     fullName / nik / passportNo / phone contains `q`
//   - paket      slug / title contains `q`
//   - agen       slug / displayName / whatsapp contains `q`
//
// Each category capped at `limit` (default 5) — autocomplete should
// feel snappy, not exhaustive. Full search page can request `limit=20`.
//
// Empty query returns empty per-category arrays + zero total. Min
// 2-char gate to avoid scanning every row on a stray keystroke.

import { db } from '../lib/db.js';

const MIN_QUERY_LEN = 2;

export async function searchAdminGlobal({ q = '', limit = 5 } = {}) {
  const query = String(q || '').trim();
  if (query.length < MIN_QUERY_LEN) {
    return {
      query, total: 0,
      bookings: [], jemaah: [], paket: [], agen: [],
    };
  }
  const cap = Math.min(50, Math.max(1, Math.floor(Number(limit) || 5)));

  // Phone normalisation — admin might paste "+62 822-1234" or "08221234".
  // Match against digits-only suffix to absorb formatting variants.
  const digitsOnly = query.replace(/\D+/g, '');
  const phoneTail = digitsOnly.length >= 4 ? digitsOnly.slice(-8) : null;

  const [bookings, jemaah, paket, agen] = await Promise.all([
    db.booking.findMany({
      where: {
        OR: [
          { bookingNo: { contains: query } },
          { jemaah: { fullName: { contains: query } } },
          ...(phoneTail ? [{ jemaah: { phone: { contains: phoneTail } } }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: cap,
      select: {
        id: true, bookingNo: true, status: true, kelas: true, paxCount: true,
        createdAt: true,
        paket: { select: { slug: true, title: true, departureDate: true } },
        jemaah: { select: { fullName: true, phone: true } },
      },
    }),
    db.jemaahProfile.findMany({
      where: {
        OR: [
          { fullName: { contains: query } },
          { nik: { contains: query } },
          { passportNo: { contains: query } },
          ...(phoneTail ? [{ phone: { contains: phoneTail } }] : []),
        ],
      },
      orderBy: { fullName: 'asc' },
      take: cap,
      select: {
        id: true, fullName: true, phone: true, nik: true, passportNo: true,
      },
    }),
    db.paket.findMany({
      where: {
        deletedAt: null,
        OR: [
          { slug: { contains: query } },
          { title: { contains: query } },
        ],
      },
      orderBy: { departureDate: 'asc' },
      take: cap,
      select: {
        id: true, slug: true, title: true, status: true,
        departureDate: true, kursiTerisi: true, kursiTotal: true,
      },
    }),
    db.agentProfile.findMany({
      where: {
        // AgentProfile has no deletedAt column; soft-delete lives on the
        // owning User. Filter via the user relation to drop agen whose
        // accounts were removed.
        user: { deletedAt: null },
        OR: [
          { slug: { contains: query } },
          { displayName: { contains: query } },
          ...(phoneTail ? [{ whatsapp: { contains: phoneTail } }] : []),
        ],
      },
      orderBy: { displayName: 'asc' },
      take: cap,
      select: {
        id: true, slug: true, displayName: true, whatsapp: true, isVerified: true,
      },
    }),
  ]);

  return {
    query,
    total: bookings.length + jemaah.length + paket.length + agen.length,
    bookings, jemaah, paket, agen,
  };
}

export { MIN_QUERY_LEN };
