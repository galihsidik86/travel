// Stage 46 — stalled lead digest. Daily email to each ACTIVE agen
// listing their WARM / COLD leads not touched in N days (default 7).
// The signal is the gap between the last meaningful event on the lead
// (createdAt or updatedAt — Prisma updates `updatedAt` on every save,
// so a recent edit = recent touch) and now.
//
// CONVERTED + LOST leads are excluded — they're terminal, no point
// nagging the agen about leads that already resolved.

import { db } from './../lib/db.js';

const ONE_DAY_MS = 86_400_000;

export async function getStalledLeadsForAgent({ agentId, staleDays = 7, now = new Date(), limit = 10 } = {}) {
  if (!agentId) return null;
  const cutoff = new Date(now.getTime() - staleDays * ONE_DAY_MS);

  const leads = await db.lead.findMany({
    where: {
      agentId,
      deletedAt: null,
      status: { in: ['COLD', 'WARM'] },
      updatedAt: { lt: cutoff },
    },
    orderBy: { updatedAt: 'asc' }, // most-stalled first
    take: limit,
    select: {
      id: true, fullName: true, phone: true, status: true,
      source: true, notes: true,
      createdAt: true, updatedAt: true,
    },
  });

  const ageDays = (d) => Math.floor((now.getTime() - d.getTime()) / ONE_DAY_MS);
  const rows = leads.map((l) => ({
    ...l,
    stalledDays: ageDays(l.updatedAt),
  }));

  return {
    rows,
    counts: {
      total: leads.length,
      cold: leads.filter((l) => l.status === 'COLD').length,
      warm: leads.filter((l) => l.status === 'WARM').length,
    },
    staleDays,
  };
}

/**
 * Iterator helper for the cron — returns every ACTIVE agen with an
 * email. Caller loops + builds + sends per-agen.
 */
export async function listActiveAgentsForLeadsDigest() {
  return db.agentProfile.findMany({
    where: {
      user: { status: 'ACTIVE', deletedAt: null, email: { not: '' } },
    },
    select: {
      id: true, slug: true, displayName: true,
      user: { select: { email: true, fullName: true } },
    },
  });
}
