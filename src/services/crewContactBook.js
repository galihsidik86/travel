// Stage 245 — crew jemaah ICE (in case of emergency) contact book.
// One read-only paginated list across ALL paket the crew is currently
// assigned to. Lets muthawwif search "Pak Budi" without flipping
// between paket pages — useful at the airport / on the bus when they
// need a name fast.
//
// Money-stripped (same convention as the rest of the crew portal):
// no totalAmount / paidAmount / komisi fields exposed. Doc statuses
// also omitted; this is a contact-only surface.
//
// ARCHIVED/soft-deleted paket excluded. CANCELLED/REFUNDED bookings
// excluded (the jemaah isn't actually going).
//
// Optional `q` substring search across jemaah name + phone + booking
// number + paket title. Trimmed; case-insensitive.

import { db } from '../lib/db.js';

const DEFAULT_PAGE_SIZE = 50;

export async function getCrewContactBook({
  userId,
  q = '',
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
} = {}) {
  if (!userId) {
    return { rows: [], pagination: { page: 1, pageSize, total: 0, pageCount: 0 } };
  }
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safePageSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || DEFAULT_PAGE_SIZE)));
  const search = String(q || '').trim();

  // Build the assignment scope: paket the crew is on, non-archived/
  // non-soft-deleted.
  const baseWhere = {
    paket: {
      crewAssignments: { some: { userId } },
      deletedAt: null,
      status: { not: 'ARCHIVED' },
    },
    status: { notIn: ['CANCELLED', 'REFUNDED'] },
  };
  if (search) {
    baseWhere.OR = [
      { jemaah: { fullName: { contains: search } } },
      { jemaah: { phone: { contains: search } } },
      { jemaah: { emergencyContact: { contains: search } } },
      { bookingNo: { contains: search } },
      { paket: { title: { contains: search } } },
    ];
  }

  const [total, rows] = await Promise.all([
    db.booking.count({ where: baseWhere }),
    db.booking.findMany({
      where: baseWhere,
      orderBy: [
        { paket: { departureDate: 'asc' } },
        { jemaah: { fullName: 'asc' } },
      ],
      skip: (safePage - 1) * safePageSize,
      take: safePageSize,
      select: {
        id: true, bookingNo: true, kelas: true, paxCount: true, status: true,
        paket: { select: { slug: true, title: true, departureDate: true } },
        jemaah: {
          select: {
            id: true, fullName: true, phone: true,
            emergencyContact: true,
            passportNo: true, passportExpiry: true,
          },
        },
        room: { select: { roomNo: true, floor: true, wing: true } },
        pickup: { select: { label: true, departTime: true } },
      },
    }),
  ]);

  const pageCount = total === 0 ? 0 : Math.ceil(total / safePageSize);
  return {
    rows,
    pagination: { page: safePage, pageSize: safePageSize, total, pageCount },
    q: search,
  };
}
