// Stage 293 — daily cron: find LUNAS bookings whose paket returned
// ~30 days ago + nudge the jemaah to come back ("how was your trip?
// here are our next departures").
//
// Per-(jemaah, paket) cooldown via the Notification table so the same
// jemaah doesn't get pinged twice for the same trip (e.g. cron re-runs).
// **Once per jemaah per paket — terminal**: even if the cron runs
// daily, the cooldown query catches any prior send, so the jemaah only
// hears from us once for this completed trip.
//
// Active-future paket list embedded in the body so the jemaah has a
// concrete next-step. Best-effort — if no active paket, skip the body
// section but still send the thank-you ping.
//
// Window: bookings with `paket.returnDate` between [now-45d, now-25d]
// gives a ±5-day band around the 30-day mark to absorb cron-misses.

import { db } from '../lib/db.js';

const DEFAULT_DAYS_BACK_MIN = 25;
const DEFAULT_DAYS_BACK_MAX = 45;

/**
 * Returns candidates: LUNAS bookings with returnDate in the window,
 * de-duped by (jemaahId, paketId) — one nudge per completed trip.
 * Excludes jemaah who've already gotten a POST_DEPARTURE_REENGAGE
 * notif for the same booking.
 */
export async function getReengageCandidates({
  now = new Date(),
  daysBackMin = DEFAULT_DAYS_BACK_MIN,
  daysBackMax = DEFAULT_DAYS_BACK_MAX,
} = {}) {
  const windowEnd = new Date(now.getTime() - daysBackMin * 86_400_000);
  const windowStart = new Date(now.getTime() - daysBackMax * 86_400_000);

  const bookings = await db.booking.findMany({
    where: {
      status: 'LUNAS',
      paket: {
        deletedAt: null,
        returnDate: { gte: windowStart, lte: windowEnd },
      },
    },
    select: {
      id: true, bookingNo: true, jemaahUserId: true,
      paket: { select: { id: true, slug: true, title: true, returnDate: true } },
      jemaah: { select: { id: true, fullName: true, phone: true, email: true } },
    },
  });

  if (bookings.length === 0) return [];

  // Per-booking cooldown via Notification: skip rows where we've already
  // sent POST_DEPARTURE_REENGAGE for this bookingId.
  const ids = bookings.map((b) => b.id);
  const prior = await db.notification.findMany({
    where: {
      type: 'POST_DEPARTURE_REENGAGE',
      relatedEntity: 'Booking',
      relatedEntityId: { in: ids },
    },
    select: { relatedEntityId: true },
  });
  const sentFor = new Set(prior.map((p) => p.relatedEntityId));
  return bookings.filter((b) => !sentFor.has(b.id));
}

export async function sendPostDepartureReengage({
  now = new Date(),
  daysBackMin = DEFAULT_DAYS_BACK_MIN,
  daysBackMax = DEFAULT_DAYS_BACK_MAX,
} = {}) {
  const candidates = await getReengageCandidates({ now, daysBackMin, daysBackMax });
  if (candidates.length === 0) {
    return { candidateCount: 0, enqueued: 0, skipped: 0 };
  }

  // Active future paket — embed top 3 in the email so jemaah has a CTA.
  const futurePaket = await db.paket.findMany({
    where: {
      status: 'ACTIVE', deletedAt: null,
      departureDate: { gte: now },
    },
    orderBy: { departureDate: 'asc' },
    take: 3,
    select: { slug: true, title: true, departureDate: true },
  });
  const nextTripsLine = futurePaket.length > 0
    ? '\n\nKalau ingin mengulang umroh, ini paket terdekat kami:\n'
      + futurePaket.map((p) => `  • ${p.title} · berangkat ${p.departureDate.toISOString().slice(0, 10)} · /p/${p.slug}`).join('\n')
    : '';

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const b of candidates) {
    const j = b.jemaah;
    if (!j || (!j.email && !j.phone)) { skipped += 1; continue; }
    const subject = `Apa kabar setelah perjalanan ${b.paket.title}?`;
    const body = [
      `Assalamu'alaikum ${j.fullName},`,
      '',
      `Sudah sekitar sebulan sejak Anda kembali dari ${b.paket.title}.`,
      'Semoga ibadah Anda diterima dan kebaikan yang dibawa pulang menetap.',
      'Bagaimana kondisi keluarga setelah perjalanan?',
      // S310 — pair the re-engage with the NPS survey link so jemaah see
      // the feedback ask organically. /saya gate enforces ownership.
      `Ada 60 detik luang? Bagi skor + cerita perjalanan: /saya/bookings/${b.id}/feedback`,
      nextTripsLine,
      '',
      'Jika Anda atau saudara berminat berangkat lagi, balas pesan ini',
      'atau hubungi tim Religio Pro langsung — kami senang membantu lagi.',
      '',
      '— Religio Pro',
    ].join('\n');
    // EMAIL preferred (longer body / paket list cleaner); WA fallback
    const channel = j.email ? 'EMAIL' : 'WA';
    const recipient = j.email ? { recipientEmail: j.email } : { recipientPhone: j.phone };
    try {
      const r = await enqueueNotification({
        type: 'POST_DEPARTURE_REENGAGE', channel,
        ...recipient,
        recipientUserId: b.jemaahUserId || null,
        subject, body,
        payload: {
          kind: 'post_departure_reengage', bookingNo: b.bookingNo,
          paketSlug: b.paket.slug,
        },
        relatedEntity: 'Booking', relatedEntityId: b.id,
      });
      if (r && r.status !== 'SKIPPED') enqueued += 1;
      else skipped += 1;
    } catch (err) {
      console.warn(`[reengage] booking ${b.bookingNo} failed:`, err?.message || err);
      skipped += 1;
    }
  }
  return { candidateCount: candidates.length, enqueued, skipped };
}
