// Stage 203 — daily passport renewal reminder. Targets jemaah whose
// `JemaahProfile.passportExpiry` is within `windowDays=90` (Saudi rule:
// passport must be valid ≥6 months after departure, so 90 days
// early lets jemaah get the renewal queue moving in time).
//
// Distinct from S173 (`DOC_EXPIRING_SOON`): that one targets
// `JemaahDocument.expiresAt`. Many jemaah have their passport metadata
// on the JemaahProfile (passportNo + passportExpiry) WITHOUT a
// JemaahDocument row, so the doc-expiring sweep misses them. This
// service walks the profile directly.
//
// Per-jemaah cooldown via the Notification table (30 days). 90-day
// window with 30-day cooldown means jemaah gets at most 3 nudges
// before passport actually expires.
//
// Silent on:
//   - jemaah without passportExpiry (we don't know when to nudge)
//   - jemaah opted out of EMAIL on JemaahProfile (S5jj)
//   - jemaah without an active user (no email/phone target)

import { db } from '../lib/db.js';

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_COOLDOWN_DAYS = 30;

export async function getPassportRenewalCandidates({
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
} = {}) {
  const cutoff = new Date(now.getTime() + windowDays * 24 * 60 * 60_000);
  const cooldownCutoff = new Date(now.getTime() - cooldownDays * 24 * 60 * 60_000);

  // Pull jemaah profiles with linked active user + passportExpiry within
  // window. Walking JemaahProfile (not Booking) so re-bookings don't
  // generate duplicate nudges per jemaah.
  const jemaah = await db.jemaahProfile.findMany({
    where: {
      passportExpiry: { not: null, lte: cutoff },
      notifEmail: true,
      user: { status: 'ACTIVE', deletedAt: null },
    },
    select: {
      id: true, fullName: true, phone: true,
      passportNo: true, passportExpiry: true,
      notifEmail: true, notifWa: true,
      user: { select: { id: true, email: true } },
    },
  });

  if (jemaah.length === 0) return { rows: [], windowDays, cooldownDays };

  // Cooldown filter: skip jemaah who got PASSPORT_RENEWAL_REMINDER
  // within cooldownDays.
  const ids = jemaah.map((j) => j.id);
  const recent = await db.notification.findMany({
    where: {
      type: 'PASSPORT_RENEWAL_REMINDER',
      relatedEntity: 'JemaahProfile',
      relatedEntityId: { in: ids },
      createdAt: { gte: cooldownCutoff },
    },
    select: { relatedEntityId: true },
  });
  const recentlyNudged = new Set(recent.map((n) => n.relatedEntityId));

  const rows = jemaah
    .filter((j) => !recentlyNudged.has(j.id))
    .map((j) => {
      const daysLeft = Math.ceil(
        (new Date(j.passportExpiry).getTime() - now.getTime()) / (24 * 60 * 60_000),
      );
      return { ...j, daysLeft };
    })
    // Soonest-expiring first
    .sort((a, b) => a.daysLeft - b.daysLeft);

  return { rows, windowDays, cooldownDays };
}

export async function sendPassportRenewalReminders({
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
} = {}) {
  const { rows } = await getPassportRenewalCandidates({ now, windowDays, cooldownDays });
  if (rows.length === 0) {
    return { jemaahCount: 0, enqueued: 0, skipped: 0, errors: 0 };
  }
  const { notifyPassportRenewal } = await import('./notifications.js');
  let enqueued = 0, skipped = 0, errors = 0;
  for (const j of rows) {
    try {
      const r = await notifyPassportRenewal({ jemaah: j });
      if (r.enqueued) enqueued += r.enqueued;
      else skipped += 1;
    } catch (err) {
      console.warn(`[passport-renewal] ${j.fullName} failed:`, err?.message || err);
      errors += 1;
    }
  }
  return { jemaahCount: rows.length, enqueued, skipped, errors };
}

export { DEFAULT_WINDOW_DAYS, DEFAULT_COOLDOWN_DAYS };
