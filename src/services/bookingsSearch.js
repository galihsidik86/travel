// Global booking search for /admin/bookings — pre-empts the "who is calling
// from this number" reflex of letting kasir scroll every paket's manifest.
//
// Search dimensions:
//   q        — fuzzy: bookingNo prefix, jemaah.fullName contains,
//              jemaah.phone contains (raw + digits-only fallback)
//   status   — exact BookingStatus, or ALL
//   paketId  — exact, or ALL
//   agentId  — exact, or NONE (Kantor Pusat / walk-in), or ALL
//   from/to  — booking.createdAt date range (YYYY-MM-DD)
//   page     — 1-based, 50 per page
//
// Returns: { rows, total, page, pageSize, totalPages, counts:{byStatus} }
// counts.byStatus is computed WITHOUT the status filter so the KPI strip
// always shows the full distribution within the current text+date scope.

import { db } from '../lib/db.js';

export const PAGE_SIZE = 50;

const BOOKING_STATUSES = ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL', 'LUNAS', 'CANCELLED', 'REFUNDED'];

function buildQueryClauses(q) {
  if (!q) return null;
  const trimmed = q.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^0-9]/g, '');
  const or = [
    // bookingNo lives uppercase + dashed (RP-2026-00012). Use raw contains
    // so partial matches anywhere in the string land (e.g. last-3 digits).
    { bookingNo: { contains: trimmed } },
    // utf8mb4_unicode_ci collation makes LIKE case-insensitive on MySQL,
    // so no `mode: 'insensitive'` needed (and unsupported in Prisma MySQL).
    { jemaah: { fullName: { contains: trimmed } } },
    { jemaah: { phone: { contains: trimmed } } },
  ];
  // Phone normalisation fallback: query "0812-3456" → digits "08123456" →
  // also try that against stored phone (which may be a different formatting).
  // Skip when digits is identical to trimmed (no formatting in the query).
  if (digits.length >= 4 && digits !== trimmed) {
    or.push({ jemaah: { phone: { contains: digits } } });
  }
  return { OR: or };
}

// Stage 182 — cancel reason filter. Matches BookingCancelReason enum
// values from S175 + '__UNSET__' sentinel for "categorised cancel rows
// without a reason code yet".
const CANCEL_REASON_CODES = [
  'JEMAAH_REQUEST', 'PAKET_CANCELLED', 'PAYMENT_NOT_RECEIVED',
  'DOCUMENT_INCOMPLETE', 'NO_SHOW', 'GOODWILL', 'OTHER',
];

export async function searchBookings({
  q = '',
  notes = '',
  status = 'ALL',
  paketId = 'ALL',
  agentId = 'ALL',
  cancelReasonCode = 'ALL',
  from = '',
  to = '',
  page = 1,
} = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);

  // Build the base WHERE without the status filter, so counts.byStatus can
  // reuse it before adding status back in.
  const baseWhere = {};
  const queryClauses = buildQueryClauses(q);
  if (queryClauses) Object.assign(baseWhere, queryClauses);

  // Stage 184 — notes text search. Substring match on Booking.notes.
  // Requires ≥3 chars so the filter doesn't silently match every row.
  const trimmedNotes = (notes || '').trim();
  if (trimmedNotes.length >= 3) {
    baseWhere.notes = { contains: trimmedNotes };
  }

  if (paketId && paketId !== 'ALL') baseWhere.paketId = paketId;

  if (agentId === 'NONE') baseWhere.agentId = null;
  else if (agentId && agentId !== 'ALL') baseWhere.agentId = agentId;

  // Stage 182 — cancel reason filter. '__UNSET__' targets cancelled rows
  // that haven't been categorised yet (admin's backlog). An enum value
  // narrows to that specific category. **Filter implicitly scopes to
  // CANCELLED + REFUNDED** since `cancelReasonCode` is only set on those.
  if (cancelReasonCode === '__UNSET__') {
    baseWhere.AND = [
      ...(baseWhere.AND || []),
      { status: { in: ['CANCELLED', 'REFUNDED'] } },
      { cancelReasonCode: null },
    ];
  } else if (cancelReasonCode && cancelReasonCode !== 'ALL' && CANCEL_REASON_CODES.includes(cancelReasonCode)) {
    baseWhere.cancelReasonCode = cancelReasonCode;
  }

  if (from || to) {
    baseWhere.createdAt = {};
    if (from) {
      const f = new Date(from);
      if (!Number.isNaN(f.getTime())) {
        f.setHours(0, 0, 0, 0);
        baseWhere.createdAt.gte = f;
      }
    }
    if (to) {
      const t = new Date(to);
      if (!Number.isNaN(t.getTime())) {
        t.setHours(23, 59, 59, 999);
        baseWhere.createdAt.lte = t;
      }
    }
    if (Object.keys(baseWhere.createdAt).length === 0) delete baseWhere.createdAt;
  }

  const whereWithStatus = status && status !== 'ALL' && BOOKING_STATUSES.includes(status)
    ? { ...baseWhere, status }
    : baseWhere;

  const [total, rows, statusGroups] = await Promise.all([
    db.booking.count({ where: whereWithStatus }),
    db.booking.findMany({
      where: whereWithStatus,
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, bookingNo: true, status: true,
        kelas: true, paxCount: true,
        totalAmount: true, paidAmount: true,
        createdAt: true,
        paket: { select: { slug: true, title: true } },
        jemaah: { select: { fullName: true, phone: true } },
        agent: { select: { slug: true, displayName: true } },
      },
    }),
    db.booking.groupBy({
      by: ['status'],
      where: baseWhere,    // intentionally without status filter
      _count: { _all: true },
    }),
  ]);

  const byStatus = Object.fromEntries(BOOKING_STATUSES.map((s) => [s, 0]));
  for (const g of statusGroups) byStatus[g.status] = g._count._all;

  return {
    rows,
    total,
    page: safePage,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: { byStatus },
  };
}

export { CANCEL_REASON_CODES };
