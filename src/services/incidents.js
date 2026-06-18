// Crew SOS / emergency incidents.
//
// Lifecycle:
//   OPEN  (crew submitted)
//    ↓ ackIncident()  — admin acknowledges they've seen it
//   ACKED
//    ↓ resolveIncident({ resolution })  — admin closes with notes
//   RESOLVED
//
// No back-transitions and no re-open — if a "resolved" SOS turns out to need
// follow-up, create a new incident. Keeps the timeline honest + audit trail
// cleanly per-incident.
//
// RBAC:
//   - createIncident: MUTHAWWIF (the crew member raising the alarm)
//   - ackIncident / resolveIncident: OWNER / SUPERADMIN / MANAJER_OPS
//
// Notif fan-out (EMAIL + WA) to the admin set runs on creation only — ack +
// resolve are internal state changes, no second blast.

import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { notifyIncidentCreated } from './notifications.js';

const PAGE_SIZE = 50;

const INCIDENT_TYPES = ['SOS', 'MEDICAL', 'LOST_JEMAAH', 'SECURITY', 'LOGISTICAL', 'OTHER'];

export const TYPE_LABELS = {
  SOS: 'SOS — darurat',
  MEDICAL: 'Medis',
  LOST_JEMAAH: 'Jemaah hilang',
  SECURITY: 'Keamanan',
  LOGISTICAL: 'Logistik',
  OTHER: 'Lain-lain',
};

const CreateSchema = z.object({
  type: z.enum(INCIDENT_TYPES),
  paketSlug: z.string().trim().min(1).max(200).optional().nullable(),
  message: z.string().trim().max(2000).optional().nullable(),
  locationLabel: z.string().trim().max(200).optional().nullable(),
});

// Stage 137 — per-crew rate-limit for non-SOS incidents. A panicking
// crew can flood the queue with repeat presses; cap at 5 / 10 min so
// the admin desk isn't paged 30 times in a minute. SOS bypasses this
// entirely (handled at the call site) — life-safety always lands.
const INCIDENT_RL_MAX = 5;
const INCIDENT_RL_WINDOW_MS = 10 * 60 * 1000;  // 10 min

/**
 * Stage 137 — throws HttpError 429 SOS_THROTTLED when the crew has
 * filed > INCIDENT_RL_MAX non-SOS incidents within the window.
 * Fail-open on store errors — the lifeline must NOT silently drop on
 * Redis blip; we'd rather take a duplicate page than miss a real one.
 */
async function enforceIncidentRateLimit(crewUser) {
  try {
    const { getRateLimitStore } = await import('../middleware/rateLimit.js');
    const store = getRateLimitStore();
    if (!store) return;  // no store, fail-open (dev / tests w/o setup)
    const { count, resetAt } = await store.hit(
      `incident:${crewUser.id}`, INCIDENT_RL_WINDOW_MS,
    );
    if (count > INCIDENT_RL_MAX) {
      const secs = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      throw new HttpError(
        429,
        `Terlalu banyak laporan dalam 10 menit. Coba lagi dalam ${secs} detik. (SOS tetap bisa dikirim kapan saja.)`,
        'SOS_THROTTLED',
      );
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.warn('[incidents] rate-limit check fail-open:', err?.message || err);
  }
}

/**
 * Resolve the (optional) paket slug to a paketId, but ONLY if the crew is
 * actually assigned to it — silently null otherwise. We don't fail the create
 * because of a bad slug (the SOS itself is more important than tagging it).
 */
async function resolvePaketForCrew(crewUserId, slug) {
  if (!slug) return null;
  const row = await db.paketCrew.findFirst({
    where: { userId: crewUserId, paket: { slug, deletedAt: null } },
    select: { paketId: true },
  });
  return row?.paketId || null;
}

/**
 * Create a new incident raised by a crew member.
 * Fan-out (admin notif) is fire-and-forget after the row write commits —
 * a notif insert failure must not abort the SOS being recorded.
 */
export async function createIncident({ req, crewUser, input }) {
  if (!crewUser || crewUser.role !== 'MUTHAWWIF') {
    throw new HttpError(403, 'Hanya crew (MUTHAWWIF) yang dapat mengirim insiden', 'FORBIDDEN');
  }
  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message || 'Input tidak valid', 'BAD_INPUT');
  }
  const data = parsed.data;
  // Stage 137 — per-crew rate-limit. A panicking crew tapping the
  // button repeatedly can flood the admin queue; we cap at 5 incidents
  // / 10min per crew user. **SOS type bypasses the limit** — life-safety
  // alerts always land regardless of how recently the crew filed others.
  // Fail-open on store errors (the SOS lifeline must not silently drop).
  if (data.type !== 'SOS') {
    await enforceIncidentRateLimit(crewUser);
  }
  const paketId = await resolvePaketForCrew(crewUser.id, data.paketSlug);

  const incident = await db.incident.create({
    data: {
      type: data.type,
      message: data.message || null,
      locationLabel: data.locationLabel || null,
      createdById: crewUser.id,
      paketId,
    },
    include: { paket: { select: { title: true, slug: true } } },
  });

  await audit({
    req,
    actor: { id: crewUser.id, email: crewUser.email, role: crewUser.role },
    action: 'CREATE',
    entity: 'Incident',
    entityId: incident.id,
    after: { type: incident.type, paketSlug: incident.paket?.slug ?? null },
  });

  // Fire-and-forget admin fan-out
  notifyIncidentCreated({
    incident,
    crew: crewUser,
    paket: incident.paket,
  }).catch((err) => console.error('[incidents] fan-out failed:', err?.message || err));

  // Stage 127 — outbound `incident.created` webhook. Best-effort.
  try {
    const { dispatchEvent } = await import('./webhooks.js');
    await dispatchEvent('incident.created', {
      incidentId: incident.id,
      type: incident.type,
      paketId: incident.paketId || null,
      paketSlug: incident.paket?.slug || null,
      crewEmail: crewUser?.email || null,
      message: incident.message || null,
      locationLabel: incident.locationLabel || null,
    });
  } catch (err) {
    console.warn('[incidents] webhook dispatch failed:', err?.message || err);
  }

  return incident;
}

export async function listIncidents({ status, type, page = 1 } = {}) {
  const where = {};
  if (status && status !== 'ALL') where.status = status;
  if (type && type !== 'ALL') where.type = type;
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const [total, rows] = await Promise.all([
    db.incident.count({ where }),
    db.incident.findMany({
      where,
      take: PAGE_SIZE,
      skip: (safePage - 1) * PAGE_SIZE,
      // OPEN bubbles to top regardless of timestamp; within a status group,
      // newest first. Achieved with a status sort (enum order = OPEN < ACKED
      // < RESOLVED matches the lifecycle naturally).
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        createdBy: { select: { id: true, email: true, fullName: true } },
        ackedBy: { select: { id: true, email: true, fullName: true } },
        resolvedBy: { select: { id: true, email: true, fullName: true } },
        paket: { select: { id: true, slug: true, title: true } },
      },
    }),
  ]);
  const counts = await db.incident.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  const countsByStatus = { OPEN: 0, ACKED: 0, RESOLVED: 0 };
  for (const c of counts) countsByStatus[c.status] = c._count._all;

  return {
    rows, total, countsByStatus,
    page: safePage, pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getIncident(id) {
  return db.incident.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, email: true, fullName: true, phone: true, role: true } },
      ackedBy: { select: { id: true, email: true, fullName: true } },
      resolvedBy: { select: { id: true, email: true, fullName: true } },
      paket: { select: { id: true, slug: true, title: true, departureDate: true } },
    },
  });
}

/**
 * List incidents created by a specific crew user (their own SOS history).
 * Crew portal shows this on the dashboard for traceability.
 */
export async function listMyIncidents(crewUserId, { limit = 20 } = {}) {
  return db.incident.findMany({
    where: { createdById: crewUserId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      paket: { select: { id: true, slug: true, title: true } },
      ackedBy: { select: { fullName: true } },
      resolvedBy: { select: { fullName: true } },
    },
  });
}

/**
 * Stage 326 — dedicated crew incident queue. Lists this crew's own
 * incidents over the last `days` window (default 30) with optional
 * `status` filter (NEW = OPEN+ACKED active queue, or specific values).
 *
 * Returns rows + KPI counts so the page renders a strip without a
 * second query. Sort: status asc (OPEN first), then createdAt desc.
 */
export async function listMyIncidentsPaginated(crewUserId, {
  status = 'ACTIVE', days = 30, limit = 200, now = new Date(),
} = {}) {
  if (!crewUserId) {
    return {
      rows: [],
      counts: { total: 0, OPEN: 0, ACKED: 0, RESOLVED: 0 },
      days, status,
    };
  }
  const since = new Date(now.getTime() - days * 86_400_000);
  // KPI counts over the full window (independent of `status` filter so
  // the strip is honest about queue state).
  const all = await db.incident.findMany({
    where: { createdById: crewUserId, createdAt: { gte: since } },
    select: { status: true },
  });
  const counts = { total: all.length, OPEN: 0, ACKED: 0, RESOLVED: 0 };
  for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;

  const where = { createdById: crewUserId, createdAt: { gte: since } };
  if (status === 'ACTIVE') where.status = { in: ['OPEN', 'ACKED'] };
  else if (status !== 'ALL') where.status = status;

  const rows = await db.incident.findMany({
    where,
    orderBy: [
      // OPEN < ACKED < RESOLVED alphabetically — good enough for queue ordering.
      { status: 'asc' },
      { createdAt: 'desc' },
    ],
    take: Math.max(1, Math.min(500, limit)),
    include: {
      paket: { select: { id: true, slug: true, title: true } },
      ackedBy: { select: { fullName: true, email: true } },
      resolvedBy: { select: { fullName: true, email: true } },
    },
  });
  // Attach ageHours so the view can colour rows by recency.
  const enriched = rows.map((r) => ({
    ...r,
    ageHours: Math.round(((now.getTime() - r.createdAt.getTime()) / 3_600_000) * 10) / 10,
  }));
  return { rows: enriched, counts, days, status };
}

export async function ackIncident({ req, adminUser, id }) {
  const cur = await db.incident.findUnique({ where: { id } });
  if (!cur) throw new HttpError(404, 'Insiden tidak ditemukan', 'NOT_FOUND');
  if (cur.status !== 'OPEN') {
    throw new HttpError(409, `Insiden sudah ${cur.status.toLowerCase()}, tidak bisa di-ack lagi`, 'NOT_ACKABLE');
  }
  const updated = await db.incident.update({
    where: { id },
    data: { status: 'ACKED', ackedById: adminUser.id, ackedAt: new Date() },
  });
  await audit({
    req,
    actor: { id: adminUser.id, email: adminUser.email, role: adminUser.role },
    action: 'STATUS_CHANGE',
    entity: 'Incident',
    entityId: id,
    before: { status: 'OPEN' },
    after: { status: 'ACKED' },
  });
  return updated;
}

const ResolveSchema = z.object({
  resolution: z.string().trim().min(3, 'Resolusi minimal 3 karakter').max(2000),
});

export async function resolveIncident({ req, adminUser, id, input }) {
  const parsed = ResolveSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message || 'Input tidak valid', 'BAD_INPUT');
  }
  const cur = await db.incident.findUnique({ where: { id } });
  if (!cur) throw new HttpError(404, 'Insiden tidak ditemukan', 'NOT_FOUND');
  if (cur.status === 'RESOLVED') {
    throw new HttpError(409, 'Insiden sudah resolved', 'ALREADY_RESOLVED');
  }
  const updated = await db.incident.update({
    where: { id },
    data: {
      status: 'RESOLVED',
      resolvedById: adminUser.id,
      resolvedAt: new Date(),
      resolution: parsed.data.resolution,
      // Auto-ack any OPEN → RESOLVED jump so the timeline still records both
      // verbs (the admin clearly saw + handled it in one go).
      ackedById: cur.ackedById ?? adminUser.id,
      ackedAt: cur.ackedAt ?? new Date(),
    },
  });
  await audit({
    req,
    actor: { id: adminUser.id, email: adminUser.email, role: adminUser.role },
    action: 'STATUS_CHANGE',
    entity: 'Incident',
    entityId: id,
    before: { status: cur.status },
    after: { status: 'RESOLVED', resolution: parsed.data.resolution },
  });

  // Stage 127 — outbound `incident.resolved` webhook. Best-effort.
  try {
    const { dispatchEvent } = await import('./webhooks.js');
    await dispatchEvent('incident.resolved', {
      incidentId: id,
      type: cur.type,
      paketId: cur.paketId || null,
      previousStatus: cur.status,
      resolution: parsed.data.resolution,
      resolvedByEmail: adminUser?.email || null,
    });
  } catch (err) {
    console.warn('[incidents] webhook dispatch failed:', err?.message || err);
  }

  return updated;
}
