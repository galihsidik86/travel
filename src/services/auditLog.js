import { db } from '../lib/db.js';

export const ENTITIES = [
  'User', 'Paket', 'PaketHotel', 'PaketDay', 'PaketHarga',
  'Booking', 'Payment', 'Komisi', 'Lead', 'Room', 'AgentProfile',
];
export const ACTIONS = [
  'CREATE', 'UPDATE', 'DELETE', 'RESTORE',
  'LOGIN', 'LOGOUT', 'PASSWORD_CHANGE',
  'PRICE_CHANGE', 'STATUS_CHANGE',
  'PAYMENT_RECEIVED', 'PAYMENT_FAILED', 'REFUND_ISSUED',
  'PERMISSION_GRANT', 'PERMISSION_REVOKE', 'EXPORT',
];

const PAGE_SIZE = 50;

/**
 * Paginated audit list with filters.
 * Returns { rows, total, page, pageSize, totalPages }.
 *
 * NOTE: AuditLog is append-only — this service never writes.
 */
export async function listAudits({
  entity, action, actorEmail, from, to, page = 1,
} = {}) {
  const where = {};
  if (entity && entity !== 'ALL') where.entity = entity;
  if (action && action !== 'ALL') where.action = action;
  if (actorEmail) where.actorEmail = { contains: actorEmail };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) {
      const t = new Date(to);
      t.setHours(23, 59, 59, 999);
      where.createdAt.lte = t;
    }
  }

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      take: PAGE_SIZE,
      skip: (safePage - 1) * PAGE_SIZE,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, action: true, entity: true, entityId: true,
        actorEmail: true, actorRole: true, ip: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    rows, total,
    page: safePage,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getAuditById(id) {
  return db.auditLog.findUnique({ where: { id } });
}
