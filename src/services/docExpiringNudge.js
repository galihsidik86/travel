// Stage 173 — daily email to jemaah whose tracked documents expire
// within `windowDays` (default 30). Groups all soon-expiring docs
// per jemaah into ONE email so they don't get N separate inbox
// hits when multiple things expire close together.
//
// Excludes REJECTED + EXPIRED docs:
//   - REJECTED: not an active credential, jemaah needs to resubmit
//     entirely, not "renew before expiry".
//   - EXPIRED: already past — covered by a different surface (the
//     S47 admin UI signal + manual follow-up).
//
// Per-jemaah cooldown via the Notification table — once nudged,
// silent for `cooldownDays` (default 7) so jemaah don't get the
// same list every single day.

import { db } from '../lib/db.js';

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_COOLDOWN_DAYS = 7;

const TYPE_LABELS = {
  PASSPORT: 'Paspor',
  VISA_UMROH: 'Visa Umroh',
  MANASIK_CERT: 'Sertifikat Manasik',
  HEALTH_CERT: 'Sertifikat Kesehatan',
  VACCINE_MENINGITIS: 'Vaksin Meningitis',
  MARRIAGE_CERT: 'Akta Nikah',
  FAMILY_CARD: 'Kartu Keluarga',
  OTHER: 'Dokumen lain',
};

export async function getDocExpiringCandidates({
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
} = {}) {
  const cutoff = new Date(now.getTime() + windowDays * 24 * 60 * 60_000);
  const cooldownCutoff = new Date(now.getTime() - cooldownDays * 24 * 60 * 60_000);

  // Soon-to-expire docs. We include "already expired" (expiresAt < now)
  // when status is NOT EXPIRED yet — those are the most urgent.
  // EXPIRED-status rows are handled by a separate path; we'd be
  // duplicating that signal here.
  const docs = await db.jemaahDocument.findMany({
    where: {
      status: { notIn: ['REJECTED', 'EXPIRED'] },
      expiresAt: { not: null, lte: cutoff },
      jemaah: {
        user: { status: 'ACTIVE', deletedAt: null },
        notifEmail: true,
      },
    },
    select: {
      id: true, type: true, expiresAt: true, status: true,
      jemaahId: true,
      jemaah: {
        select: {
          id: true, fullName: true, userId: true, notifEmail: true,
          user: { select: { email: true, id: true } },
        },
      },
    },
  });

  if (docs.length === 0) return { rows: [], windowDays, cooldownDays };

  // Group by jemaah — one email per jemaah with all their expiring docs.
  const perJemaah = new Map();
  for (const d of docs) {
    if (!d.jemaah) continue;
    let row = perJemaah.get(d.jemaahId);
    if (!row) {
      row = { jemaah: d.jemaah, docs: [] };
      perJemaah.set(d.jemaahId, row);
    }
    const daysLeft = d.expiresAt
      ? Math.ceil((d.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60_000))
      : null;
    row.docs.push({
      id: d.id, type: d.type, typeLabel: TYPE_LABELS[d.type] || d.type,
      expiresAt: d.expiresAt, daysLeft, status: d.status,
    });
  }

  // Cooldown — exclude jemaah who got DOC_EXPIRING_SOON within cooldown.
  const jemaahIds = [...perJemaah.keys()];
  const recent = await db.notification.findMany({
    where: {
      type: 'DOC_EXPIRING_SOON',
      relatedEntity: 'JemaahProfile',
      relatedEntityId: { in: jemaahIds },
      createdAt: { gte: cooldownCutoff },
    },
    select: { relatedEntityId: true },
  });
  const recentlyNudged = new Set(recent.map((n) => n.relatedEntityId));

  const rows = [];
  for (const r of perJemaah.values()) {
    if (recentlyNudged.has(r.jemaah.id)) continue;
    // Sort docs soonest-expiring first
    r.docs.sort((a, b) => {
      const ax = a.expiresAt ? a.expiresAt.getTime() : Infinity;
      const bx = b.expiresAt ? b.expiresAt.getTime() : Infinity;
      return ax - bx;
    });
    rows.push(r);
  }
  // Most-urgent jemaah first (their soonest-expiring doc)
  rows.sort((a, b) => {
    const ax = a.docs[0]?.expiresAt?.getTime() ?? Infinity;
    const bx = b.docs[0]?.expiresAt?.getTime() ?? Infinity;
    return ax - bx;
  });
  return { rows, windowDays, cooldownDays };
}

export async function sendDocExpiringNudges({
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
} = {}) {
  const { rows } = await getDocExpiringCandidates({ now, windowDays, cooldownDays });
  if (rows.length === 0) {
    return { jemaahCount: 0, enqueued: 0, skipped: 0, errors: 0 };
  }
  const { notifyDocExpiringSoon } = await import('./notifications.js');
  let enqueued = 0, skipped = 0, errors = 0;
  for (const r of rows) {
    try {
      const result = await notifyDocExpiringSoon({
        jemaah: r.jemaah, docs: r.docs,
      });
      if (result.enqueued) enqueued += result.enqueued;
      else skipped += 1;
    } catch (err) {
      console.warn(`[doc-expiring] jemaah ${r.jemaah.fullName} failed:`, err?.message || err);
      errors += 1;
    }
  }
  return { jemaahCount: rows.length, enqueued, skipped, errors };
}

export { DEFAULT_WINDOW_DAYS, DEFAULT_COOLDOWN_DAYS, TYPE_LABELS };
