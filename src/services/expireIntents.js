// 5uu: scan PaymentIntent rows whose `expiresAt` has passed but status is
// still CREATED/PENDING, and transition each to EXPIRED with an audit row.
//
// Why an automated sweep when 5qq already provides manual admin cancel?
// Snap sessions die silently when jemaah closes the tab — Midtrans doesn't
// always send an `expire` webhook in that case. Without this job, the
// active-intent guard (`createPaymentIntent` refuses a 2nd intent if one
// is CREATED/PENDING) would force admin intervention every time. The sweep
// keeps the queue clean automatically.
//
// Idempotent — re-running is a no-op once everything eligible is marked.
// Terminal statuses (SETTLED/EXPIRED/CANCELLED/FAILED) are NEVER touched,
// matching the broader "terminal frozen" invariant from 5pp.
//
// Safe to call from:
//   - CLI (`node src/jobs/expire-intents.js`) — system cron
//   - HTTP trigger (`POST /api/admin/jobs/expire-intents`) — manual run
//
// Pass `actor: null` to attribute to "system". Role intentionally omitted —
// Role enum has no SYSTEM member, so actorRole stays NULL.
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';

export async function expireStaleIntents({ req, actor, now = new Date() } = {}) {
  const stale = await db.paymentIntent.findMany({
    where: {
      expiresAt: { lt: now },
      status: { in: ['CREATED', 'PENDING'] },
    },
    select: { id: true, orderId: true, bookingId: true, status: true, expiresAt: true },
  });

  let expired = 0;
  const errors = [];
  for (const intent of stale) {
    try {
      await db.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'EXPIRED' },
      });
      await audit({
        req: req ?? null,
        actor: actor ?? { email: 'system' },
        action: 'STATUS_CHANGE',
        entity: 'PaymentIntent',
        entityId: intent.id,
        before: { status: intent.status },
        after: {
          status: 'EXPIRED',
          orderId: intent.orderId,
          bookingId: intent.bookingId,
          expiresAt: intent.expiresAt,
          autoExpired: true,
        },
      });
      expired += 1;
    } catch (err) {
      errors.push({ intentId: intent.id, error: err.message });
    }
  }
  return { scanned: stale.length, expired, errors };
}
