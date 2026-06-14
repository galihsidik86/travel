// Stage 279 — two related digests on top of S277 crew daily reports.
//
// 1. Evening WA reminder to crew who haven't submitted today's report
//    yet, BUT only for paket that are currently "in trip" (today is
//    between departureDate and returnDate inclusive). Crew on a paket
//    that hasn't departed shouldn't get a nudge.
//
// 2. Morning admin email summarising yesterday's missed reports across
//    all in-trip paket. Helps OWNER+SUPERADMIN+MANAJER_OPS see which
//    trips lack accountability.
//
// Per-recipient cooldown via the Notification table:
//   - reminder: 12h cooldown (so a re-run mid-evening doesn't double up)
//   - admin missed digest: 20h cooldown (daily cadence)

import { db } from '../lib/db.js';

const ADMIN_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];

function startOfDayUTC(d = new Date()) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function startOfDayLocal(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Find crew assigned to paket that are mid-trip today (departureDate
 * ≤ today ≤ returnDate) AND haven't submitted a report for today yet.
 *
 * Returns an array of `{user, paket}` pairs — each one needs its own
 * nudge (a single crew on multiple in-trip paket gets multiple rows).
 */
export async function getCrewMissingTodayReport({ now = new Date() } = {}) {
  const todayLocal = startOfDayLocal(now);
  const todayUtc = startOfDayUTC(now);
  // 1) Find in-trip paket today
  const inTrip = await db.paket.findMany({
    where: {
      deletedAt: null,
      departureDate: { lte: todayLocal },
      returnDate: { gte: todayLocal },
    },
    select: {
      id: true, slug: true, title: true, departureDate: true, returnDate: true,
      crewAssignments: {
        select: {
          user: { select: { id: true, email: true, phone: true, fullName: true, status: true } },
        },
      },
    },
  });
  if (inTrip.length === 0) return [];

  // 2) For each (paket, crew) pair, check if today's report exists.
  const pairs = [];
  for (const p of inTrip) {
    for (const a of p.crewAssignments) {
      if (a.user.status !== 'ACTIVE') continue;
      pairs.push({ paket: p, user: a.user });
    }
  }
  if (pairs.length === 0) return [];

  // Pull existing reports for today across the candidate pool
  const existing = await db.crewDailyReport.findMany({
    where: {
      reportDate: todayUtc,
      paketId: { in: inTrip.map((p) => p.id) },
      crewUserId: { in: pairs.map((p) => p.user.id) },
    },
    select: { paketId: true, crewUserId: true },
  });
  const haveKey = (paketId, userId) => `${paketId}::${userId}`;
  const have = new Set(existing.map((e) => haveKey(e.paketId, e.crewUserId)));
  return pairs.filter(({ paket, user }) => !have.has(haveKey(paket.id, user.id)));
}

/**
 * Send the reminder WA to each missing crew. 12h cooldown per
 * (recipientUserId, paket).
 */
export async function sendCrewDailyReportReminder({ now = new Date() } = {}) {
  const pairs = await getCrewMissingTodayReport({ now });
  if (pairs.length === 0) {
    return { candidateCount: 0, enqueued: 0, skipped: 0 };
  }

  const cooldownCutoff = new Date(now.getTime() - 12 * 3_600_000);
  const recent = await db.notification.findMany({
    where: {
      type: 'CREW_DAILY_REPORT_REMINDER',
      recipientUserId: { in: pairs.map((p) => p.user.id) },
      createdAt: { gte: cooldownCutoff },
    },
    select: { recipientUserId: true, relatedEntityId: true },
  });
  const recentKey = new Set(recent.map((r) => `${r.relatedEntityId}::${r.recipientUserId}`));

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const { user, paket } of pairs) {
    if (recentKey.has(`${paket.id}::${user.id}`)) { skipped += 1; continue; }
    if (!user.phone && !user.email) { skipped += 1; continue; }
    const body = `Assalamu'alaikum ${user.fullName}, laporan harian untuk paket "${paket.title}" belum dikirim hari ini. Mohon submit di /crew/paket/${paket.slug}. Bismillah. — Religio Pro`;
    try {
      // WA preferred (real-time); EMAIL as fallback
      const channel = user.phone ? 'WA' : 'EMAIL';
      const r = await enqueueNotification({
        type: 'CREW_DAILY_REPORT_REMINDER',
        channel,
        recipientUserId: user.id,
        recipientPhone: user.phone,
        recipientEmail: user.email,
        subject: channel === 'EMAIL' ? `[Crew] Laporan harian belum dikirim · ${paket.title}` : undefined,
        body,
        relatedEntity: 'Paket', relatedEntityId: paket.id,
      });
      if (r && r.status !== 'SKIPPED') enqueued += 1;
      else skipped += 1;
    } catch (err) {
      console.warn(`[crew-daily-report-reminder] ${user.email} / ${paket.slug} failed:`, err?.message || err);
      skipped += 1;
    }
  }
  return { candidateCount: pairs.length, enqueued, skipped };
}

/**
 * Morning admin digest of YESTERDAY's missed reports. Lists each
 * (paket, crew) that should have reported but didn't, so admin can
 * chase. Silent when nothing missed.
 */
export async function sendCrewDailyReportMissedAdmin({ now = new Date() } = {}) {
  // Yesterday window
  const yesterdayLocal = startOfDayLocal(now);
  yesterdayLocal.setDate(yesterdayLocal.getDate() - 1);
  const yesterdayUtc = startOfDayUTC(yesterdayLocal);

  const inTripYesterday = await db.paket.findMany({
    where: {
      deletedAt: null,
      departureDate: { lte: yesterdayLocal },
      returnDate: { gte: yesterdayLocal },
    },
    select: {
      id: true, slug: true, title: true,
      crewAssignments: {
        select: { user: { select: { id: true, email: true, fullName: true, status: true } } },
      },
    },
  });
  if (inTripYesterday.length === 0) {
    return { missedCount: 0, recipientCount: 0, enqueued: 0, skipped: 0 };
  }

  const pairs = [];
  for (const p of inTripYesterday) {
    for (const a of p.crewAssignments) {
      if (a.user.status !== 'ACTIVE') continue;
      pairs.push({ paket: p, user: a.user });
    }
  }

  const existing = await db.crewDailyReport.findMany({
    where: {
      reportDate: yesterdayUtc,
      paketId: { in: inTripYesterday.map((p) => p.id) },
    },
    select: { paketId: true, crewUserId: true },
  });
  const have = new Set(existing.map((e) => `${e.paketId}::${e.crewUserId}`));
  const missed = pairs.filter(({ paket, user }) => !have.has(`${paket.id}::${user.id}`));
  if (missed.length === 0) {
    return { missedCount: 0, recipientCount: 0, enqueued: 0, skipped: 0 };
  }

  // Group missed entries per-paket for the email body
  const byPaket = new Map();
  for (const { paket, user } of missed) {
    if (!byPaket.has(paket.id)) byPaket.set(paket.id, { paket, crew: [] });
    byPaket.get(paket.id).crew.push(user);
  }
  const groups = [...byPaket.values()];

  const admins = await db.user.findMany({
    where: { role: { in: ADMIN_ROLES }, status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true },
  });
  const cooldownCutoff = new Date(now.getTime() - 20 * 3_600_000);
  const recent = await db.notification.findMany({
    where: {
      type: 'CREW_DAILY_REPORT_MISSED_ADMIN', channel: 'EMAIL',
      recipientEmail: { in: admins.map((a) => a.email) },
      createdAt: { gte: cooldownCutoff },
    },
    select: { recipientEmail: true },
  });
  const recentSet = new Set(recent.map((n) => n.recipientEmail));

  const ymd = `${yesterdayLocal.getFullYear()}-${String(yesterdayLocal.getMonth() + 1).padStart(2, '0')}-${String(yesterdayLocal.getDate()).padStart(2, '0')}`;
  const subject = `[Crew] ${missed.length} laporan harian terlewat (${ymd})`;
  const lines = [
    `${missed.length} crew × paket kombinasi tidak mengirim laporan harian untuk ${ymd}.`,
    '',
    ...groups.map((g) => (
      `• ${g.paket.title} (${g.paket.slug}):\n  ${g.crew.map((c) => `${c.fullName} <${c.email}>`).join('\n  ')}`
    )),
    '',
    'Tindak lanjuti via /crew portal atau hubungi crew langsung.',
  ];
  const body = lines.join('\n');

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const a of admins) {
    if (recentSet.has(a.email)) { skipped += 1; continue; }
    try {
      const r = await enqueueNotification({
        type: 'CREW_DAILY_REPORT_MISSED_ADMIN', channel: 'EMAIL',
        recipientEmail: a.email,
        subject, body,
        relatedEntity: 'CrewDailyReport', relatedEntityId: null,
        payload: { missedCount: missed.length, groupCount: groups.length, ymd },
      });
      if (r && r.status !== 'SKIPPED') enqueued += 1;
      else skipped += 1;
    } catch (err) {
      console.warn(`[crew-missed-admin] ${a.email} failed:`, err?.message || err);
      skipped += 1;
    }
  }
  return { missedCount: missed.length, recipientCount: admins.length, enqueued, skipped };
}
