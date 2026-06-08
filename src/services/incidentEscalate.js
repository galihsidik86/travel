// Stage 80 — auto-escalate OPEN incidents older than 60 minutes that
// haven't been acked yet. Idempotent: stamps `escalatedAt` once so
// repeat cron runs skip already-escalated rows.
//
// Pairs with stage 13's incident fan-out:
//   - stage 13: initial OPEN → fans EMAIL+WA+PUSH to all admins
//   - stage 80: still OPEN after 60min → second-tier escalation,
//                EMAIL only, targets just the OWNER subset (top of
//                the hierarchy, on the assumption that the admin
//                desk missed the first alert)

import { db } from './../lib/db.js';

const ONE_MIN_MS = 60_000;

export async function escalateStaleIncidents({ now = new Date(), olderThanMin = 60 } = {}) {
  const cutoff = new Date(now.getTime() - olderThanMin * ONE_MIN_MS);

  const stale = await db.incident.findMany({
    where: {
      status: 'OPEN',
      createdAt: { lt: cutoff },
      escalatedAt: null,
    },
    select: {
      id: true, type: true, message: true, createdAt: true,
      createdBy: { select: { fullName: true, phone: true } },
      paket: { select: { slug: true, title: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (stale.length === 0) {
    return { scanned: 0, escalated: 0, candidates: [] };
  }

  // Pull OWNER users (tighter scope than the original fan-out) so we
  // don't spam the whole admin desk twice.
  const owners = await db.user.findMany({
    where: {
      role: 'OWNER',
      status: 'ACTIVE',
      deletedAt: null,
      email: { not: '' },
    },
    select: { email: true },
  });

  // Lazy-import to keep the cron lean — notify helper pulls in templates.
  const { notifyIncidentEscalated } = await import('./notifications.js');

  let escalated = 0;
  for (const inc of stale) {
    try {
      const ageMin = Math.floor((now.getTime() - inc.createdAt.getTime()) / ONE_MIN_MS);
      await notifyIncidentEscalated({ incident: inc, ageMin, owners });
      await db.incident.update({
        where: { id: inc.id },
        data: { escalatedAt: now },
      });
      escalated += 1;
    } catch (err) {
      console.warn(`[incident-escalate] failed for ${inc.id}:`, err?.message || err);
    }
  }

  return { scanned: stale.length, escalated, candidates: stale.map((s) => s.id) };
}
