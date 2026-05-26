import { db } from './db.js';

/**
 * Append-only audit log writer. Never updates or deletes existing rows.
 * Failures are logged but do not block the calling request.
 */
export async function audit({
  req,
  actor = null,         // { id, email, role } or null for anonymous
  action,               // AuditAction enum
  entity,               // string ("User", "Booking", ...)
  entityId = null,
  before = null,
  after = null,
}) {
  try {
    await db.auditLog.create({
      data: {
        actorUserId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        actorRole: actor?.role ?? null,
        action,
        entity,
        entityId,
        before: before ?? undefined,
        after: after ?? undefined,
        ip: req ? getClientIp(req) : null,
        userAgent: req?.headers?.['user-agent']?.slice(0, 500) ?? null,
      },
    });
  } catch (err) {
    console.error('[audit] failed to write log:', err.message);
  }
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}
