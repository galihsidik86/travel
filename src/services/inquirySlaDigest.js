// Stage 291 — daily admin digest of stale public inquiries.
//
// Surface: any NEW or CONTACTED inquiry older than `staleHours`
// (default 24h). Admin gets one EMAIL per day with the backlog —
// silent on healthy days.
//
// Why both NEW + CONTACTED: NEW = nobody touched it; CONTACTED =
// someone said "I'll handle this" but didn't follow through to
// CONVERT or ARCHIVE. Both need the prod.

import { db } from '../lib/db.js';

const ADMIN_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];
const DEFAULT_STALE_HOURS = 24;
const COOLDOWN_HOURS = 20;

export async function getStaleInquiries({ now = new Date(), staleHours = DEFAULT_STALE_HOURS } = {}) {
  const cutoff = new Date(now.getTime() - staleHours * 3_600_000);
  const rows = await db.publicInquiry.findMany({
    where: {
      status: { in: ['NEW', 'CONTACTED'] },
      createdAt: { lte: cutoff },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, fullName: true, phone: true, email: true,
      paketSlug: true, agentSlug: true, status: true,
      message: true, createdAt: true,
    },
  });
  return rows.map((r) => ({
    ...r,
    ageHours: Math.floor((now.getTime() - r.createdAt.getTime()) / 3_600_000),
  }));
}

export async function sendInquirySlaDigest({ now = new Date(), staleHours = DEFAULT_STALE_HOURS } = {}) {
  const rows = await getStaleInquiries({ now, staleHours });
  if (rows.length === 0) {
    return { rowCount: 0, recipientCount: 0, enqueued: 0, skipped: 0 };
  }

  const admins = await db.user.findMany({
    where: { role: { in: ADMIN_ROLES }, status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true },
  });
  const cooldownCutoff = new Date(now.getTime() - COOLDOWN_HOURS * 3_600_000);
  const recent = await db.notification.findMany({
    where: {
      type: 'GENERIC', channel: 'EMAIL',
      recipientEmail: { in: admins.map((a) => a.email) },
      payload: { path: '$.kind', equals: 'inquiry_sla_digest' },
      createdAt: { gte: cooldownCutoff },
    },
    select: { recipientEmail: true },
  });
  const recentSet = new Set(recent.map((n) => n.recipientEmail));

  const newCount = rows.filter((r) => r.status === 'NEW').length;
  const contactedCount = rows.filter((r) => r.status === 'CONTACTED').length;
  const oldestHours = rows[0]?.ageHours ?? 0;

  const subject = `[Inquiry SLA] ${rows.length} inquiry > ${staleHours}j tanpa progress (terlama ${oldestHours}j)`;
  const top10 = rows.slice(0, 10);
  const restCount = Math.max(0, rows.length - top10.length);
  const lines = [
    `${rows.length} inquiry belum di-convert/archive setelah ${staleHours} jam.`,
    `Breakdown: ${newCount} NEW · ${contactedCount} CONTACTED.`,
    `Terlama menunggu: ${oldestHours} jam.`,
    '',
    'Top stale:',
    ...top10.map((r, i) => (
      `${String(i + 1).padStart(2, ' ')}. [${r.status}] ${r.fullName} · ${r.phone}`
      + (r.paketSlug ? ` · ${r.paketSlug}` : '')
      + ` · sudah ${r.ageHours}j`
    )),
  ];
  if (restCount > 0) lines.push(`\n+ ${restCount} lainnya — buka /admin/inquiries`);
  lines.push('\nReview + convert/archive: /admin/inquiries');
  const body = lines.join('\n');

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const a of admins) {
    if (recentSet.has(a.email)) { skipped += 1; continue; }
    try {
      const r = await enqueueNotification({
        type: 'GENERIC', channel: 'EMAIL',
        recipientEmail: a.email,
        subject, body,
        payload: { kind: 'inquiry_sla_digest', rowCount: rows.length, newCount, contactedCount, oldestHours },
        relatedEntity: 'PublicInquiry', relatedEntityId: null,
      });
      if (r && r.status !== 'SKIPPED') enqueued += 1;
      else skipped += 1;
    } catch (err) {
      console.warn(`[inquiry-sla] ${a.email} failed:`, err?.message || err);
      skipped += 1;
    }
  }
  return { rowCount: rows.length, recipientCount: admins.length, enqueued, skipped };
}
