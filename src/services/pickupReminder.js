// Stage 219 — daily reminder for jemaah on a soon-departing paket
// who haven't picked a pickup point yet. Pairs with S196 (pickup
// curation) + S202 (jemaah self-pick) + S212 (capacity cap).
//
// "Why this isn't a passive UI nudge alone": jemaah doesn't always
// re-open /saya/bookings/:id before takeoff. A push/email/WA reminder
// closes the gap so the manifest doesn't end up with 30% TBD on
// departure day.
//
// Per-booking cooldown via the Notification table (5 days). 14-day
// window with 5-day cooldown → max ~3 nudges before takeoff. Silent
// when no candidates.

import { db } from '../lib/db.js';
import { enqueueNotification } from './notifications.js';

const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_COOLDOWN_DAYS = 5;

export async function getPickupReminderCandidates({
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
} = {}) {
  const cutoff = new Date(now.getTime() + windowDays * 24 * 60 * 60_000);
  const cooldownCutoff = new Date(now.getTime() - cooldownDays * 24 * 60 * 60_000);

  // Active bookings on near-departure paket WHERE pickup not chosen yet
  // AND the paket actually offers pickups (else nothing to remind about).
  // We don't filter the "paket has pickups" condition in the SQL because
  // Prisma can't easily express "relation has at least one row" alongside
  // the other filters cleanly — instead we filter in JS after fetch.
  const bookings = await db.booking.findMany({
    where: {
      pickupId: null,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      paket: {
        departureDate: { gte: now, lte: cutoff },
        deletedAt: null,
        status: { not: 'ARCHIVED' },
      },
    },
    select: {
      id: true, bookingNo: true, paketId: true,
      jemaahUserId: true,
      jemaah: {
        select: {
          id: true, fullName: true, phone: true, email: true,
          notifEmail: true, notifWa: true,
        },
      },
      paket: {
        select: {
          id: true, slug: true, title: true, departureDate: true,
          // Only include the count to validate "has pickups"
          _count: { select: { pickups: true } },
        },
      },
    },
  });

  // Drop bookings whose paket has zero pickup points (admin hasn't
  // curated yet → can't remind about something that doesn't exist).
  const withPickups = bookings.filter((b) => (b.paket?._count?.pickups || 0) > 0);
  if (withPickups.length === 0) return { rows: [], windowDays, cooldownDays };

  // Cooldown filter: skip bookings nudged in the last `cooldownDays`.
  const bookingIds = withPickups.map((b) => b.id);
  const recent = await db.notification.findMany({
    where: {
      type: 'PICKUP_REMINDER',
      relatedEntity: 'Booking',
      relatedEntityId: { in: bookingIds },
      createdAt: { gte: cooldownCutoff },
    },
    select: { relatedEntityId: true },
  });
  const recentlyNudged = new Set(recent.map((n) => n.relatedEntityId));

  const rows = withPickups
    .filter((b) => !recentlyNudged.has(b.id))
    .map((b) => {
      const daysLeft = Math.ceil(
        (new Date(b.paket.departureDate).getTime() - now.getTime()) / (24 * 60 * 60_000),
      );
      return { ...b, daysLeft };
    })
    // Soonest-departing first so the per-run quota (if added later) hits the urgent ones
    .sort((a, b) => a.daysLeft - b.daysLeft);

  return { rows, windowDays, cooldownDays };
}

/**
 * Per-row enqueue. Fires BOTH EMAIL + WA when contacts are present
 * (the worker + opt-out filters in enqueueNotification handle which
 * channels actually deliver). Silent when jemaah has neither.
 * `recipientUserId` set for `/saya/notifications` inbox routing.
 */
export async function notifyPickupReminder(candidate) {
  const j = candidate.jemaah;
  if (!j) return { skipped: true, reason: 'no_jemaah' };
  if (!j.email && !j.phone) return { skipped: true, reason: 'no_contact' };

  const dep = candidate.paket.departureDate
    ? new Date(candidate.paket.departureDate).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'TBA';
  const subject = `[Pengingat] Pilih lokasi pickup untuk ${candidate.paket.title}`;
  const bodyLines = [
    `Halo ${j.fullName || 'Jemaah'},`,
    '',
    `Paket "${candidate.paket.title}" berangkat ${dep} (${candidate.daysLeft} hari lagi).`,
    'Anda belum memilih titik penjemputan bus.',
    '',
    `Buka /saya/bookings/${candidate.id} untuk memilih sekarang.`,
    'Jika tidak memilih sebelum keberangkatan, lokasi akan default ke TBD',
    'dan admin akan menghubungi Anda untuk konfirmasi.',
    '',
    '— Religio Pro',
  ].join('\n');

  let enqueued = 0;
  try {
    if (j.email) {
      await enqueueNotification({
        type: 'PICKUP_REMINDER',
        channel: 'EMAIL',
        recipientEmail: j.email,
        recipientUserId: candidate.jemaahUserId || null,
        subject,
        body: bodyLines,
        payload: {
          bookingId: candidate.id,
          bookingNo: candidate.bookingNo,
          paketSlug: candidate.paket.slug,
          daysLeft: candidate.daysLeft,
        },
        relatedEntity: 'Booking',
        relatedEntityId: candidate.id,
      });
      enqueued += 1;
    }
    if (j.phone) {
      await enqueueNotification({
        type: 'PICKUP_REMINDER',
        channel: 'WA',
        recipientPhone: j.phone,
        recipientUserId: candidate.jemaahUserId || null,
        subject,
        body: bodyLines,
        payload: {
          bookingId: candidate.id,
          bookingNo: candidate.bookingNo,
          paketSlug: candidate.paket.slug,
          daysLeft: candidate.daysLeft,
        },
        relatedEntity: 'Booking',
        relatedEntityId: candidate.id,
      });
      enqueued += 1;
    }
    return { enqueued };
  } catch (err) {
    return { skipped: true, reason: 'enqueue_failed', error: err?.message || String(err) };
  }
}

export async function sendPickupReminders({
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
  cooldownDays = DEFAULT_COOLDOWN_DAYS,
} = {}) {
  const { rows } = await getPickupReminderCandidates({ now, windowDays, cooldownDays });
  if (rows.length === 0) {
    return { bookingCount: 0, enqueued: 0, skipped: 0, errors: 0 };
  }
  let enqueued = 0, skipped = 0, errors = 0;
  for (const b of rows) {
    try {
      const r = await notifyPickupReminder(b);
      if (r.enqueued) enqueued += r.enqueued;
      else skipped += 1;
    } catch (err) {
      console.warn(`[pickup-reminder] ${b.bookingNo} failed:`, err?.message || err);
      errors += 1;
    }
  }
  return { bookingCount: rows.length, enqueued, skipped, errors };
}

export { DEFAULT_WINDOW_DAYS, DEFAULT_COOLDOWN_DAYS };
