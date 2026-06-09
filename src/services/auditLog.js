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

// Stage 138 — CSV export bounds.
const EXPORT_MAX_DAYS = 90;        // longest reasonable single-pull window
const EXPORT_DEFAULT_DAYS = 7;     // typical "what changed last week?" ask
const EXPORT_ROW_CAP = 50_000;     // hard ceiling — a wide filter shouldn't OOM
const EXPORT_BATCH = 1_000;

/**
 * Stage 138 — escape a value for RFC 4180 CSV. Wraps in quotes when
 * the value contains comma / quote / newline; doubles embedded quotes.
 * Null / undefined → empty string. Objects → JSON-stringified.
 */
export function csvEscape(v) {
  if (v == null) return '';
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Stage 138 — clamp + normalise the requested window. Defaults to the
 * last 7 days; caps at 90. Returns absolute Date objects with day
 * boundaries pinned (from = 00:00:00, to = 23:59:59.999) so a partial-
 * day "to" doesn't silently drop late entries.
 */
export function resolveExportRange({ from, to, now = new Date() } = {}) {
  const toDate = to ? new Date(to) : now;
  toDate.setHours(23, 59, 59, 999);
  let fromDate;
  if (from) {
    fromDate = new Date(from);
  } else {
    fromDate = new Date(toDate);
    fromDate.setDate(toDate.getDate() - (EXPORT_DEFAULT_DAYS - 1));
  }
  fromDate.setHours(0, 0, 0, 0);
  // Cap window at MAX_DAYS by walking `from` forward (keep the recent
  // end intact — "last 90 of the requested range" is more useful than
  // "first 90" for compliance asks like "show me activity for X").
  //
  // floor() rather than round() so a same-day request (from 00:00, to
  // 23:59:59.999 → 0.999 days diff) resolves to 1 inclusive day, not 2.
  const msPerDay = 24 * 60 * 60 * 1000;
  const requestedDays = Math.floor((toDate.getTime() - fromDate.getTime()) / msPerDay) + 1;
  if (requestedDays > EXPORT_MAX_DAYS) {
    fromDate = new Date(toDate);
    fromDate.setDate(toDate.getDate() - (EXPORT_MAX_DAYS - 1));
    fromDate.setHours(0, 0, 0, 0);
  }
  return { from: fromDate, to: toDate, days: Math.min(requestedDays, EXPORT_MAX_DAYS) };
}

/**
 * Stage 138 — stream audit rows as CSV to the provided write stream.
 * UTF-8 BOM prefixed so Excel auto-detects encoding (mirrors S106 CSV
 * convention). before/after columns are JSON-stringified. Batched
 * 1000 rows at a time via cursor to keep memory bounded.
 *
 * Filters mirror listAudits (entity / action / actorEmail / from / to).
 * `from + to` are clamped via `resolveExportRange` — see EXPORT_MAX_DAYS.
 *
 * Returns `{rowsWritten, capped, range}`. `capped=true` when the row
 * limit was hit — caller should warn admin to narrow filters.
 */
export async function exportAuditCsv({
  entity, action, actorEmail, from, to, writeStream,
} = {}) {
  if (!writeStream || typeof writeStream.write !== 'function') {
    throw new Error('exportAuditCsv: writeStream required');
  }

  const range = resolveExportRange({ from, to });
  const where = { createdAt: { gte: range.from, lte: range.to } };
  if (entity && entity !== 'ALL') where.entity = entity;
  if (action && action !== 'ALL') where.action = action;
  if (actorEmail) where.actorEmail = { contains: actorEmail };

  // UTF-8 BOM + header row (mirrors S106 csv bundle convention)
  writeStream.write('\uFEFF');
  const COLUMNS = [
    'id', 'createdAt', 'action', 'entity', 'entityId',
    'actorEmail', 'actorRole', 'ip', 'userAgent',
    'before', 'after',
  ];
  writeStream.write(COLUMNS.join(',') + '\r\n');

  let rowsWritten = 0;
  let capped = false;
  let cursor = null;
  while (rowsWritten < EXPORT_ROW_CAP) {
    const remaining = EXPORT_ROW_CAP - rowsWritten;
    const batchTake = Math.min(EXPORT_BATCH, remaining);
    const findArgs = {
      where,
      take: batchTake,
      orderBy: { createdAt: 'asc' },
      // cursor-based pagination by id (stable across createdAt ties)
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, createdAt: true, action: true, entity: true, entityId: true,
        actorEmail: true, actorRole: true, ip: true, userAgent: true,
        before: true, after: true,
      },
    };
    const batch = await db.auditLog.findMany(findArgs);
    if (batch.length === 0) break;
    for (const r of batch) {
      writeStream.write(COLUMNS.map((c) => csvEscape(r[c])).join(',') + '\r\n');
    }
    rowsWritten += batch.length;
    cursor = batch[batch.length - 1].id;
    if (batch.length < batchTake) break;
  }
  if (rowsWritten >= EXPORT_ROW_CAP) capped = true;
  return { rowsWritten, capped, range };
}

export { EXPORT_MAX_DAYS, EXPORT_DEFAULT_DAYS, EXPORT_ROW_CAP };

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
