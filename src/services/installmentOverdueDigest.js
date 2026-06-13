// Stage 272 — daily admin digest of bookings with overdue installments.
//
// Distinct from S172 PAYMENT_REMINDER (that's jemaah-side, "you have a
// balance"). This is admin-facing: "these N bookings have at least one
// installment past its dueDate — they need follow-up".
//
// Window: looks at ALL active bookings with a schedule (no date range
// filter), since overdue is by definition independent of departure
// proximity. CANCELLED/REFUNDED excluded.
//
// Cooldown: per-recipient 1 day. The digest runs daily so we don't
// need a longer cooldown — the absence of new overdue is itself the
// "silence" signal.

import { db } from '../lib/db.js';
import { summariseSchedule } from './bookingInstallments.js';

const ADMIN_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];

/**
 * Returns the list of active bookings whose schedule carries at least
 * one overdue installment, plus each booking's overdue-count + total
 * overdue Idr. Sorted by overdueIdr desc so the largest leaks bubble up.
 */
export async function getOverdueInstallmentBookings({ now = new Date() } = {}) {
  const bookings = await db.booking.findMany({
    where: {
      status: { in: ['PENDING', 'BOOKED', 'DP_PAID', 'PARTIAL'] },
      installmentSchedule: { not: null },
      paket: { deletedAt: null },
    },
    select: {
      id: true, bookingNo: true, status: true,
      totalAmount: true, paidAmount: true, installmentSchedule: true,
      paket: { select: { slug: true, title: true, departureDate: true } },
      jemaah: { select: { fullName: true, phone: true } },
      agent: { select: { slug: true, displayName: true } },
    },
  });
  const rows = [];
  for (const b of bookings) {
    const schedule = Array.isArray(b.installmentSchedule) ? b.installmentSchedule : null;
    const summary = summariseSchedule(schedule, { now });
    if (!summary || summary.overdueCount === 0) continue;
    const todayYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const overdueIdr = schedule
      .filter((i) => i.status !== 'PAID' && i.dueDate < todayYmd)
      .reduce((acc, i) => acc + i.amountIdr, 0);
    rows.push({
      bookingId: b.id, bookingNo: b.bookingNo, status: b.status,
      jemaahName: b.jemaah?.fullName || '—',
      paketTitle: b.paket?.title || '—',
      paketSlug: b.paket?.slug,
      departureDate: b.paket?.departureDate || null,
      agentSlug: b.agent?.slug || null,
      agentName: b.agent?.displayName || null,
      overdueCount: summary.overdueCount,
      overdueIdr,
      nextDue: summary.nextDue,
    });
  }
  rows.sort((a, b) => b.overdueIdr - a.overdueIdr);
  return rows;
}

/**
 * Fan-out: enqueue one EMAIL per ACTIVE admin matching ADMIN_ROLES,
 * skipping recipients who already received an INSTALLMENT_OVERDUE_ADMIN
 * within the last 1 day (cooldown).
 *
 * Silent when zero overdue bookings — no email fired on healthy days.
 */
export async function sendInstallmentOverdueDigest({ now = new Date() } = {}) {
  const rows = await getOverdueInstallmentBookings({ now });
  if (rows.length === 0) {
    return { rowCount: 0, recipientCount: 0, enqueued: 0, skipped: 0 };
  }

  const admins = await db.user.findMany({
    where: { role: { in: ADMIN_ROLES }, status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true, fullName: true },
  });

  // Cooldown: skip admins who got one in the last 24h.
  const cooldownCutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  const recentEmails = await db.notification.findMany({
    where: {
      type: 'INSTALLMENT_OVERDUE_ADMIN',
      channel: 'EMAIL',
      recipientEmail: { in: admins.map((a) => a.email) },
      createdAt: { gte: cooldownCutoff },
    },
    select: { recipientEmail: true },
  });
  const recentSet = new Set(recentEmails.map((n) => n.recipientEmail));

  const totalOverdueIdr = rows.reduce((acc, r) => acc + r.overdueIdr, 0);
  const top10 = rows.slice(0, 10);
  const restCount = Math.max(0, rows.length - top10.length);

  const subject = `[Installment] ${rows.length} booking telat cicilan · Rp ${Math.round(totalOverdueIdr).toLocaleString('id-ID')}`;
  const lines = [
    `${rows.length} booking memiliki cicilan overdue per ${now.toISOString().slice(0, 10)}.`,
    `Total nilai overdue: Rp ${Math.round(totalOverdueIdr).toLocaleString('id-ID')}.`,
    '',
    ...top10.map((r, i) => (
      `${String(i + 1).padStart(2, ' ')}. ${r.bookingNo} · ${r.jemaahName} · ${r.paketTitle}`
      + ` · ${r.overdueCount} cicilan overdue · Rp ${Math.round(r.overdueIdr).toLocaleString('id-ID')}`
      + (r.agentSlug ? ` · agen: ${r.agentName || r.agentSlug}` : ' · walk-in')
    )),
  ];
  if (restCount > 0) lines.push(`\n+ ${restCount} booking lainnya — buka /admin/installments-overdue`);
  lines.push('\nLihat antrian + kirim reminder per booking di /admin/installments-overdue.');
  const body = lines.join('\n');

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const a of admins) {
    if (recentSet.has(a.email)) {
      skipped += 1;
      continue;
    }
    try {
      const r = await enqueueNotification({
        type: 'INSTALLMENT_OVERDUE_ADMIN', channel: 'EMAIL',
        recipientEmail: a.email,
        subject, body,
        relatedEntity: 'Booking', relatedEntityId: null,
        payload: { rowCount: rows.length, totalOverdueIdr },
      });
      if (r && r.status !== 'SKIPPED') enqueued += 1;
      else skipped += 1;
    } catch (err) {
      console.warn(`[installment-overdue-digest] ${a.email} failed:`, err?.message || err);
      skipped += 1;
    }
  }

  return { rowCount: rows.length, recipientCount: admins.length, enqueued, skipped };
}
