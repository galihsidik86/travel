// Stage 227 — auto-publish scheduled paket. Daily cron flips DRAFT
// paket to ACTIVE when `publishedAt <= now` AND the paket is past the
// minimum sanity checks (has title, departureDate, kursiTotal). Admin
// can pre-schedule a launch by setting publishedAt to a future date
// while keeping status=DRAFT; this cron handles the handoff on the day.
//
// Why DRAFT-only: ARCHIVED/CLOSED rows shouldn't get re-activated;
// already-ACTIVE rows are no-ops. The publishedAt column already
// existed (paketAdmin.js sets it when admin manually flips to ACTIVE)
// so we don't need a separate "scheduled" column.
//
// Silent on quiet days. Per-paket failure caught so a bad row doesn't
// abort the batch.

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';

export async function getAutoPublishCandidates({ now = new Date() } = {}) {
  return db.paket.findMany({
    where: {
      status: 'DRAFT',
      publishedAt: { lte: now, not: null },
      deletedAt: null,
      // Sanity guards — don't auto-publish a paket missing essentials.
      // Departure must still be in the future (no point activating a
      // trip that's already happened/passed).
      departureDate: { gt: now },
      // kursiTotal default is 0 in some forms; require at least 1.
      kursiTotal: { gt: 0 },
    },
    select: {
      id: true, slug: true, title: true,
      departureDate: true, publishedAt: true, kursiTotal: true,
    },
  });
}

export async function autoPublishOne({ paketId, actor, req, now = new Date() }) {
  const updated = await db.paket.update({
    where: { id: paketId },
    data: { status: 'ACTIVE' },
    select: { id: true, slug: true, status: true },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Paket', entityId: paketId,
    before: { status: 'DRAFT' },
    after: {
      status: 'ACTIVE',
      autoPublished: true,
      publishedAtFiredAt: now.toISOString(),
    },
  });
  return updated;
}

export async function runAutoPublishPaket({ now = new Date() } = {}) {
  const candidates = await getAutoPublishCandidates({ now });
  if (candidates.length === 0) {
    return { candidates: 0, published: 0, failed: 0 };
  }
  // System actor — null id avoids the AuditLog FK constraint; the
  // `autoPublished: true` marker in the after payload is the durable
  // distinguisher from admin manual activation.
  const actor = { id: null, email: 'system', role: null };
  const req = { ip: null, headers: {}, get: () => null };
  let published = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      await autoPublishOne({ paketId: c.id, actor, req, now });
      published += 1;
    } catch (err) {
      console.warn(`[autoPublishPaket] ${c.slug} failed:`, err?.message || err);
      failed += 1;
    }
  }
  return { candidates: candidates.length, published, failed };
}
