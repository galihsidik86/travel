// Stage 312 — daily cron: nudge LUNAS jemaah at ~60d post-return who
// haven't submitted TripFeedback yet.
//
// Why 60d (not piggyback on S293 at 30d): the S293 email already plants
// the link organically, but jemaah at the 30d mark are still adjusting.
// At 60d they're settled + can reflect. Per-booking terminal cooldown
// keeps this strictly once-only per trip.
//
// Window: `paket.returnDate ∈ [now-65d, now-55d]` gives a ±5d band
// around the 60d mark to absorb cron-misses.
//
// Engagement opt-out (S309) enforced via `jemaah.notifEngagement:true`
// at the query level — same convention as S307/S308. The feedback
// nudge is "marketing-adjacent" so it shares the opt-out lever.

import { db } from '../lib/db.js';

const DEFAULT_DAYS_BACK_MIN = 55;
const DEFAULT_DAYS_BACK_MAX = 65;

export async function getFeedbackReminderCandidates({
  now = new Date(),
  daysBackMin = DEFAULT_DAYS_BACK_MIN,
  daysBackMax = DEFAULT_DAYS_BACK_MAX,
} = {}) {
  const windowEnd = new Date(now.getTime() - daysBackMin * 86_400_000);
  const windowStart = new Date(now.getTime() - daysBackMax * 86_400_000);

  // Bookings in window WITHOUT existing TripFeedback. Prisma:
  // `tripFeedback: null` filter is the canonical way.
  const bookings = await db.booking.findMany({
    where: {
      status: 'LUNAS',
      tripFeedback: null,
      paket: {
        deletedAt: null,
        returnDate: { gte: windowStart, lte: windowEnd },
      },
      jemaah: { notifEngagement: true },
    },
    select: {
      id: true, bookingNo: true, jemaahUserId: true,
      paket: { select: { id: true, slug: true, title: true } },
      jemaah: { select: { id: true, fullName: true, phone: true, email: true } },
    },
  });
  if (bookings.length === 0) return [];

  // Terminal cooldown — skip any booking that's already been nudged.
  // (TripFeedback existence check above handles the happy path; this
  // catches bookings that were nudged but jemaah ignored the link.)
  const ids = bookings.map((b) => b.id);
  const prior = await db.notification.findMany({
    where: {
      type: 'TRIP_FEEDBACK_REMINDER',
      relatedEntity: 'Booking',
      relatedEntityId: { in: ids },
    },
    select: { relatedEntityId: true },
  });
  const sentFor = new Set(prior.map((p) => p.relatedEntityId));
  return bookings.filter((b) => !sentFor.has(b.id));
}

export async function sendTripFeedbackReminders({
  now = new Date(),
  daysBackMin = DEFAULT_DAYS_BACK_MIN,
  daysBackMax = DEFAULT_DAYS_BACK_MAX,
} = {}) {
  const candidates = await getFeedbackReminderCandidates({ now, daysBackMin, daysBackMax });
  if (candidates.length === 0) {
    return { candidateCount: 0, enqueued: 0, skipped: 0 };
  }
  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const b of candidates) {
    const j = b.jemaah;
    if (!j || (!j.email && !j.phone)) { skipped += 1; continue; }
    const firstName = (j.fullName || 'Jemaah').split(/\s+/)[0];
    const subject = `60 detik untuk ${b.paket.title} — bantu kami perbaiki`;
    const body = [
      `Assalamu'alaikum ${firstName},`,
      '',
      `Sudah dua bulan sejak ${b.paket.title}. Cukup waktu untuk merefleksikan`,
      'apa yang berkesan dan apa yang bisa diperbaiki.',
      '',
      `Bagi skor + cerita di /saya/bookings/${b.id}/feedback`,
      'Hanya tim internal yang lihat — bukan testimoni publik.',
      '',
      'Skor jujur Anda kami pakai untuk paket berikutnya.',
      '',
      '— Religio Pro',
    ].join('\n');
    const channel = j.email ? 'EMAIL' : 'WA';
    const recipient = j.email ? { recipientEmail: j.email } : { recipientPhone: j.phone };
    try {
      const r = await enqueueNotification({
        type: 'TRIP_FEEDBACK_REMINDER', channel,
        ...recipient,
        recipientUserId: b.jemaahUserId || null,
        subject, body,
        payload: {
          kind: 'trip_feedback_reminder', bookingNo: b.bookingNo,
          paketSlug: b.paket.slug,
        },
        relatedEntity: 'Booking', relatedEntityId: b.id,
      });
      if (r && r.status !== 'SKIPPED') enqueued += 1;
      else skipped += 1;
    } catch (err) {
      console.warn(`[trip-feedback-reminder] booking ${b.bookingNo} failed:`, err?.message || err);
      skipped += 1;
    }
  }
  return { candidateCount: candidates.length, enqueued, skipped };
}
