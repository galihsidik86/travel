// Stage 276 — daily admin digest of SUBMITTED docs that have been
// waiting > 48h for staff verification.
//
// Distinct from S274 in-app queue (synchronous browsing) — this is the
// daily nudge to OWNER+SUPERADMIN+MANAJER_OPS when verification has
// slipped beyond SLA. Silent on healthy days.
//
// 48h budget chosen so a Friday submission doesn't fire on Sunday but
// will fire Monday morning — the cooldown + budget together give us
// "weekend forgiven, Monday accountable" semantics.

import { db } from '../lib/db.js';

const ADMIN_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];
const DEFAULT_BUDGET_HOURS = 48;
const COOLDOWN_HOURS = 24;

/**
 * Returns SUBMITTED docs older than budgetHours.
 * Sorted by submittedAt asc (oldest waiting longest at the top).
 */
export async function getStaleSubmittedDocs({ now = new Date(), budgetHours = DEFAULT_BUDGET_HOURS } = {}) {
  const cutoff = new Date(now.getTime() - budgetHours * 3_600_000);
  const docs = await db.jemaahDocument.findMany({
    where: { status: 'SUBMITTED', submittedAt: { lte: cutoff, not: null } },
    orderBy: { submittedAt: 'asc' },
    select: {
      id: true, type: true, refNumber: true, submittedAt: true,
      jemaah: { select: { id: true, fullName: true } },
    },
  });
  return docs.map((d) => ({
    docId: d.id, type: d.type, refNumber: d.refNumber,
    jemaahId: d.jemaah.id, jemaahName: d.jemaah.fullName,
    submittedAt: d.submittedAt,
    ageHours: d.submittedAt ? Math.floor((now.getTime() - d.submittedAt.getTime()) / 3_600_000) : null,
  }));
}

/**
 * Per-type tally for the email summary line.
 */
function tallyByType(rows) {
  const out = {};
  for (const r of rows) out[r.type] = (out[r.type] || 0) + 1;
  return out;
}

/**
 * Fan out one EMAIL per ACTIVE admin (cooldown-aware).
 * Silent on zero stale docs.
 */
export async function sendDocVerifySlaDigest({ now = new Date(), budgetHours = DEFAULT_BUDGET_HOURS } = {}) {
  const rows = await getStaleSubmittedDocs({ now, budgetHours });
  if (rows.length === 0) {
    return { rowCount: 0, recipientCount: 0, enqueued: 0, skipped: 0 };
  }

  const admins = await db.user.findMany({
    where: { role: { in: ADMIN_ROLES }, status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true, fullName: true },
  });
  const cooldownCutoff = new Date(now.getTime() - COOLDOWN_HOURS * 3_600_000);
  const recent = await db.notification.findMany({
    where: {
      type: 'DOC_VERIFY_SLA_ADMIN', channel: 'EMAIL',
      recipientEmail: { in: admins.map((a) => a.email) },
      createdAt: { gte: cooldownCutoff },
    },
    select: { recipientEmail: true },
  });
  const recentSet = new Set(recent.map((n) => n.recipientEmail));

  const tally = tallyByType(rows);
  const top10 = rows.slice(0, 10);
  const restCount = Math.max(0, rows.length - top10.length);
  const oldestHours = rows[0]?.ageHours ?? 0;

  const subject = `[Doc SLA] ${rows.length} dokumen menunggu verifikasi > ${budgetHours}j (terlama ${oldestHours}j)`;
  const lines = [
    `${rows.length} dokumen SUBMITTED menunggu verifikasi > ${budgetHours} jam.`,
    `Terlama menunggu: ${oldestHours} jam.`,
    '',
    'Per tipe:',
    ...Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([t, n]) => `  ${t}: ${n}`),
    '',
    'Top stale:',
    ...top10.map((r, i) => (
      `${String(i + 1).padStart(2, ' ')}. ${r.type} · ${r.jemaahName}`
      + (r.refNumber ? ` · ref: ${r.refNumber}` : '')
      + ` · sudah ${r.ageHours}j`
    )),
  ];
  if (restCount > 0) lines.push(`\n+ ${restCount} lainnya — buka /admin/docs-pending`);
  lines.push('\nQueue + bulk-actions: /admin/docs-pending');
  const body = lines.join('\n');

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const a of admins) {
    if (recentSet.has(a.email)) { skipped += 1; continue; }
    try {
      const r = await enqueueNotification({
        type: 'DOC_VERIFY_SLA_ADMIN', channel: 'EMAIL',
        recipientEmail: a.email,
        subject, body,
        relatedEntity: 'JemaahDocument', relatedEntityId: null,
        payload: { rowCount: rows.length, oldestHours, budgetHours },
      });
      if (r && r.status !== 'SKIPPED') enqueued += 1;
      else skipped += 1;
    } catch (err) {
      console.warn(`[doc-verify-sla] ${a.email} failed:`, err?.message || err);
      skipped += 1;
    }
  }
  return { rowCount: rows.length, recipientCount: admins.length, enqueued, skipped };
}
