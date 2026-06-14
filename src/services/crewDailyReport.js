// Stage 277 — crew daily report submission + lookup.
//
// Assigned MUTHAWWIF submits one report per (paket, crew, reportDate).
// Composite-unique → re-submit upserts the same row rather than stacking
// duplicates. Distinct from S187 per-jemaah notes (which are about
// individual jemaah); this is per-trip-day overall status.

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const MOODS = new Set(['GREEN', 'AMBER', 'RED']);

function localYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDayLocal(d) {
  // For @db.Date columns, use UTC midnight so the value lands as a
  // canonical YYYY-MM-DD without TZ-driven drift. Reads + writes
  // produce the same Date instance regardless of server TZ.
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/**
 * Assert that the crew is assigned to the paket. Returns the paket row
 * for further use. Throws 404 NOT_ASSIGNED (anti-enumeration — same
 * pattern as the rest of the crew portal).
 */
async function assertAssigned({ paketSlug, userId }) {
  const paket = await db.paket.findFirst({
    where: { slug: paketSlug, deletedAt: null },
    select: { id: true, slug: true, title: true, departureDate: true, durationDays: true },
  });
  if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'NOT_ASSIGNED');
  const assignment = await db.paketCrew.findUnique({
    where: { paketId_userId: { paketId: paket.id, userId } },
    select: { paketId: true },
  });
  if (!assignment) throw new HttpError(404, 'Anda tidak ditugaskan ke paket ini', 'NOT_ASSIGNED');
  return paket;
}

/**
 * Compute dayNumber from departureDate + today. Returns null when
 * we can't determine (e.g. departureDate unset).
 * Day 1 = departureDate.
 */
function computeDayNumber({ departureDate, reportDate }) {
  if (!departureDate || !reportDate) return null;
  const dep = startOfDayLocal(departureDate);
  const rep = startOfDayLocal(reportDate);
  const diffDays = Math.round((rep.getTime() - dep.getTime()) / 86_400_000);
  // Negative means before departure — return null (out of trip)
  if (diffDays < 0) return null;
  return diffDays + 1;
}

/**
 * Submit (or update) a crew daily report.
 *
 * Idempotent on (paket, crew, reportDate) — re-submitting the same date
 * upserts. Audit row carries `crewReportUpserted: true` so the timeline
 * shows revisions.
 */
export async function submitCrewDailyReport({ req, actor, userId, paketSlug, reportDate, body, mood = 'GREEN' }) {
  if (!body || body.trim().length < 5) {
    throw new HttpError(400, 'Isi laporan wajib (min. 5 karakter)', 'REPORT_BODY_REQUIRED');
  }
  if (body.length > 4000) {
    throw new HttpError(400, 'Laporan terlalu panjang (max 4000 karakter)', 'REPORT_BODY_TOO_LONG');
  }
  const moodNorm = String(mood || 'GREEN').toUpperCase();
  if (!MOODS.has(moodNorm)) {
    throw new HttpError(400, 'Mood tidak valid (GREEN/AMBER/RED)', 'REPORT_BAD_MOOD');
  }
  // Default reportDate to today (local) when caller omits
  const rd = reportDate ? startOfDayLocal(new Date(reportDate)) : startOfDayLocal(new Date());
  const paket = await assertAssigned({ paketSlug, userId });

  const dayNumber = computeDayNumber({ departureDate: paket.departureDate, reportDate: rd });

  const data = {
    paketId: paket.id, crewUserId: userId,
    reportDate: rd, dayNumber, mood: moodNorm,
    body: body.trim().slice(0, 4000),
  };

  // Upsert via the composite unique
  const before = await db.crewDailyReport.findUnique({
    where: { paketId_crewUserId_reportDate: { paketId: paket.id, crewUserId: userId, reportDate: rd } },
    select: { id: true, mood: true, body: true },
  });

  const report = await db.crewDailyReport.upsert({
    where: { paketId_crewUserId_reportDate: { paketId: paket.id, crewUserId: userId, reportDate: rd } },
    create: data,
    update: { mood: moodNorm, body: data.body, dayNumber },
  });

  await audit({
    req, actor,
    action: before ? 'UPDATE' : 'CREATE',
    entity: 'CrewDailyReport', entityId: report.id,
    before: before ? { mood: before.mood, body: before.body?.slice(0, 200) } : null,
    after: {
      mood: report.mood,
      body: report.body.slice(0, 200),
      paketSlug: paket.slug,
      reportDate: localYmd(rd),
      dayNumber,
      crewReportUpserted: !!before,
    },
  });

  return report;
}

/**
 * Crew-side: list this crew's reports on the assigned paket, latest
 * first. Used to render the recent-reports panel on the crew portal.
 */
export async function listMyCrewReports({ userId, paketSlug, limit = 30 }) {
  const paket = await assertAssigned({ paketSlug, userId });
  return db.crewDailyReport.findMany({
    where: { paketId: paket.id, crewUserId: userId },
    orderBy: { reportDate: 'desc' },
    take: Math.min(Math.max(Number(limit) || 30, 1), 90),
    select: {
      id: true, reportDate: true, dayNumber: true, mood: true, body: true,
      createdAt: true, updatedAt: true,
    },
  });
}

/**
 * Admin-side: list ALL reports for a paket across all crew, latest
 * first. For the per-paket panel on admin edit page.
 */
export async function listPaketReports({ paketSlug, limit = 50 }) {
  const paket = await db.paket.findFirst({
    where: { slug: paketSlug, deletedAt: null },
    select: { id: true, slug: true, title: true },
  });
  if (!paket) return null;
  const reports = await db.crewDailyReport.findMany({
    where: { paketId: paket.id },
    orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(Number(limit) || 50, 1), 200),
    select: {
      id: true, reportDate: true, dayNumber: true, mood: true, body: true,
      createdAt: true, updatedAt: true,
      crewUser: { select: { id: true, fullName: true, email: true } },
    },
  });
  return { paket, reports };
}

/**
 * Admin-overview tally: per-mood count over the last `days` days
 * across non-archived paket. Powers the manifest-tab badge in S278.
 */
export async function getRecentReportTally({ days = 7 } = {}) {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const grouped = await db.crewDailyReport.groupBy({
    by: ['mood'],
    where: { reportDate: { gte: cutoff }, paket: { deletedAt: null } },
    _count: { _all: true },
  });
  const tally = { GREEN: 0, AMBER: 0, RED: 0 };
  for (const g of grouped) tally[g.mood] = g._count._all;
  return { days, tally, total: tally.GREEN + tally.AMBER + tally.RED };
}
