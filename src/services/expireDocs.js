import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';

/**
 * Scan JemaahDocument rows where expiresAt has passed and status is still
 * "active" (PENDING/SUBMITTED/VERIFIED/REJECTED), then transition each to
 * EXPIRED in a single write + write an audit row per doc.
 *
 * Returns { scanned, expired, errors }.
 *
 * Idempotent — re-running on the same window is a no-op once everything
 * eligible has already been marked EXPIRED.
 *
 * Safe to call from:
 *   - CLI (`node src/jobs/expire-docs.js`) — system cron
 *   - HTTP trigger (`POST /api/admin/jobs/expire-docs`) — manual run
 *   - In-process (future) — node-cron / setInterval at startup
 *
 * Pass `actor: null` to attribute writes to "system". The audit row sets
 * actorEmail to whatever you supply, so a CLI run typically uses
 * `{ email: 'system' }`.
 */
export async function expireOverdueDocuments({ req, actor, now = new Date() } = {}) {
  const overdue = await db.jemaahDocument.findMany({
    where: {
      expiresAt: { lt: now },
      status: { notIn: ['EXPIRED'] },
    },
    select: { id: true, jemaahId: true, type: true, status: true, expiresAt: true },
  });

  let expired = 0;
  const errors = [];

  for (const doc of overdue) {
    try {
      await db.jemaahDocument.update({
        where: { id: doc.id },
        data: { status: 'EXPIRED' },
      });
      await audit({
        req: req ?? null,
        // role intentionally omitted — Role enum has no SYSTEM member, so we leave
        // actorRole NULL and signal "system" via actorEmail = 'system'.
        actor: actor ?? { email: 'system' },
        action: 'STATUS_CHANGE',
        entity: 'JemaahDocument',
        entityId: doc.id,
        before: { status: doc.status },
        after: {
          status: 'EXPIRED',
          jemaahId: doc.jemaahId,
          type: doc.type,
          expiresAt: doc.expiresAt,
          autoExpired: true,
        },
      });
      expired += 1;
    } catch (err) {
      errors.push({ docId: doc.id, error: err.message });
    }
  }

  return { scanned: overdue.length, expired, errors };
}
