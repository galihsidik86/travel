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

/**
 * Daily audit activity for the filter scope — one row per UTC day in range.
 * Used for the sparkline above the audit list. Same filter inputs as
 * listAudits() so the chart matches the table the user is staring at.
 *
 * Range defaults to last 14 days when neither `from` nor `to` is provided.
 * Caps at 90 days to keep the SVG readable + the query bounded.
 */
export async function getAuditActivity({
  entity, action, actorEmail, from, to,
} = {}) {
  const now = new Date();
  // Default: last 14 days inclusive (13 days back + today).
  const defaultFrom = new Date(now);
  defaultFrom.setUTCDate(now.getUTCDate() - 13);
  defaultFrom.setUTCHours(0, 0, 0, 0);

  const rawFrom = from ? new Date(from) : defaultFrom;
  rawFrom.setUTCHours(0, 0, 0, 0);
  const rawToEnd = to ? new Date(to) : now;
  rawToEnd.setUTCHours(23, 59, 59, 999);
  const rawToDayStart = new Date(rawToEnd);
  rawToDayStart.setUTCHours(0, 0, 0, 0);

  // Day count is inclusive of both ends — work in whole UTC days.
  const MAX_DAYS = 90;
  const msPerDay = 24 * 60 * 60 * 1000;
  let days = Math.round((rawToDayStart - rawFrom) / msPerDay) + 1;
  if (days < 1) days = 1;
  days = Math.min(MAX_DAYS, days);

  // If clamped, walk effective from-date forward so the chart shows the
  // most recent 90 days rather than a window starting in the distant past.
  const effFrom = new Date(rawToDayStart);
  effFrom.setUTCDate(rawToDayStart.getUTCDate() - (days - 1));
  effFrom.setUTCHours(0, 0, 0, 0);
  const toDate = rawToEnd;

  const where = {
    createdAt: { gte: effFrom, lte: toDate },
  };
  if (entity && entity !== 'ALL') where.entity = entity;
  if (action && action !== 'ALL') where.action = action;
  if (actorEmail) where.actorEmail = { contains: actorEmail };

  const rows = await db.auditLog.findMany({
    where,
    select: { createdAt: true, action: true },
    take: 50_000, // hard cap; pagination is for the visible table, this is for the chart
  });

  const allDays = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(effFrom);
    d.setUTCDate(effFrom.getUTCDate() + i);
    allDays.push(d.toISOString().slice(0, 10));
  }

  const dayMap = new Map(allDays.map((d) => [d, { date: d, count: 0, byAction: {} }]));
  const actionTotals = {};
  for (const r of rows) {
    const k = r.createdAt.toISOString().slice(0, 10);
    const bucket = dayMap.get(k);
    if (!bucket) continue; // safety: outside range somehow
    bucket.count += 1;
    bucket.byAction[r.action] = (bucket.byAction[r.action] || 0) + 1;
    actionTotals[r.action] = (actionTotals[r.action] || 0) + 1;
  }

  return {
    daily: allDays.map((d) => dayMap.get(d)),
    actionTotals,
    rangeFrom: effFrom,
    rangeTo: toDate,
    rangeDays: days,
    totalCount: rows.length,
  };
}
