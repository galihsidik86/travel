// Stage 31 — items that need an operator to do something, surfaced as
// one panel on the /admin overview tab AND appended to the OWNER daily
// digest email. Three categories, each with a hard 24h "ageing" window:
//
//   - notifsFailed:   terminal-FAILED notification rows (queue gave up
//                     after MAX_ATTEMPTS or nextRetryAt=null). The owner
//                     can decide to RETRY (resets attemptCount) or accept
//                     the loss. Without this surface they'd never know.
//   - cancelRequests: jemaah-side cancel requests that an admin hasn't
//                     yet approved or rejected. Ageing matters because the
//                     jemaah is in limbo until the booking transitions.
//   - openIncidents:  crew SOS / field incidents still in OPEN status
//                     more than 24h after being raised. Either nobody
//                     ACK'd it (escalation needed) or the ACK→RESOLVED
//                     follow-through stalled.
//
// Read-only; never writes. The panel and email are surfaces — admin
// actions still happen on the relevant detail pages.

import { db } from './../lib/db.js';

const ONE_DAY_MS = 24 * 60 * 60_000;

export async function getNeedsAttention({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - ONE_DAY_MS);

  const [notifsFailed, cancelRequests, openIncidents] = await Promise.all([
    // Terminal-FAILED: the queue worker stopped retrying. Either the row
    // burned through MAX_ATTEMPTS or it was hard-failed with nextRetryAt=null.
    // Cap at 20 — anything bigger is a queue-wide problem, not an inbox.
    db.notification.findMany({
      where: {
        status: 'FAILED',
        OR: [
          { nextRetryAt: null },
          { attemptCount: { gte: 5 } },
        ],
      },
      orderBy: { lastAttemptAt: 'desc' },
      take: 20,
      select: {
        id: true, type: true, channel: true, subject: true,
        recipientEmail: true, recipientPhone: true,
        attemptCount: true, error: true, lastAttemptAt: true, createdAt: true,
      },
    }),
    // Cancel requests >24h pending. A jemaah's request sets cancelRequested=true
    // but does NOT change Booking.status — admin still has to approve.
    // We want the OLD ones (>24h) so brand-new requests don't crowd the panel.
    db.booking.findMany({
      where: {
        cancelRequested: true,
        cancelRequestedAt: { lt: cutoff },
        status: { notIn: ['CANCELLED', 'REFUNDED'] },
      },
      orderBy: { cancelRequestedAt: 'asc' },
      take: 20,
      select: {
        id: true, bookingNo: true, status: true,
        cancelRequestedAt: true, cancelRequestReason: true,
        paidAmount: true, totalAmount: true,
        jemaah: { select: { fullName: true, phone: true } },
        paket: { select: { title: true, slug: true } },
      },
    }),
    // OPEN incidents older than 24h. Either nobody ACK'd, or ACK happened
    // but resolve stalled. The page already exists at /admin/incidents — we
    // just want the *aged* OPEN ones surfaced as a nudge here.
    db.incident.findMany({
      where: { status: 'OPEN', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: {
        id: true, type: true, message: true,
        createdAt: true,
        createdBy: { select: { fullName: true } },
        paket: { select: { title: true, slug: true } },
      },
    }),
  ]);

  // Pre-compute "age in hours" so the view doesn't have to. Round down so
  // a 24h31m item reads as "24 jam" not "25 jam".
  const ageHours = (d) => Math.floor((now.getTime() - d.getTime()) / (60 * 60_000));

  return {
    notifsFailed: notifsFailed.map((n) => ({ ...n, ageHours: ageHours(n.lastAttemptAt || n.createdAt) })),
    cancelRequests: cancelRequests.map((b) => ({ ...b, ageHours: ageHours(b.cancelRequestedAt) })),
    openIncidents: openIncidents.map((i) => ({ ...i, ageHours: ageHours(i.createdAt) })),
    counts: {
      notifsFailed: notifsFailed.length,
      cancelRequests: cancelRequests.length,
      openIncidents: openIncidents.length,
      total: notifsFailed.length + cancelRequests.length + openIncidents.length,
    },
  };
}
