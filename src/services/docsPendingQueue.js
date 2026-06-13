// Stage 274 — admin queue of JemaahDocument rows awaiting staff
// verification. Pulls all SUBMITTED docs across all jemaah; sorted by
// submittedAt asc (oldest waiting longest land at the top).
//
// Distinct from the per-jemaah view at `/admin/jemaah/:id/edit` — that's
// the per-customer detail; this is the cross-customer "what needs my
// attention RIGHT NOW" surface.
//
// Filters CANCELLED/REFUNDED bookings out of the implied jemaah pool
// indirectly — we DON'T filter by booking status here because a jemaah
// may legitimately have a verified passport unrelated to any specific
// booking (e.g. they re-book later). Doc state lives on JemaahProfile,
// not Booking.

import { db } from '../lib/db.js';

/**
 * Returns SUBMITTED docs awaiting verify + per-row context for the table.
 *
 * @param {object} opts
 * @param {string} [opts.docType] — optional filter to one of the 8 doc types
 * @param {number} [opts.limit=200] — soft cap so the page doesn't blow up
 */
export async function getPendingDocs({ docType = null, limit = 200 } = {}) {
  const where = { status: 'SUBMITTED' };
  if (docType) where.type = docType;
  const docs = await db.jemaahDocument.findMany({
    where,
    orderBy: { submittedAt: 'asc' },
    take: Math.min(Math.max(Number(limit) || 200, 1), 500),
    select: {
      id: true, type: true, refNumber: true, expiresAt: true,
      submittedAt: true, filePath: true, fileName: true, mimeType: true,
      jemaah: {
        select: {
          id: true, fullName: true, phone: true, email: true,
          // Surface the latest non-cancelled booking so admin sees
          // which trip context this doc is for (heuristic — jemaah may
          // have multiple bookings, but the latest active is usually
          // the one driving the submission).
          bookings: {
            where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true, bookingNo: true,
              paket: { select: { slug: true, title: true, departureDate: true } },
            },
          },
        },
      },
    },
  });

  // Compute per-row ageHours (server side so view doesn't have to know now())
  const now = Date.now();
  const rows = docs.map((d) => ({
    ...d,
    ageHours: d.submittedAt ? Math.floor((now - d.submittedAt.getTime()) / 3_600_000) : null,
    booking: d.jemaah?.bookings?.[0] || null,
  }));
  return rows;
}

/**
 * Tally per docType for the KPI strip + filter dropdown.
 * Always returns all 8 doc types (zero-count rows included).
 */
export async function getPendingDocCounts() {
  const grouped = await db.jemaahDocument.groupBy({
    by: ['type'],
    where: { status: 'SUBMITTED' },
    _count: { _all: true },
  });
  const map = Object.fromEntries(grouped.map((g) => [g.type, g._count._all]));
  return map;
}
