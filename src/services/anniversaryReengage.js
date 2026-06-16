// Stage 308 — daily cron: one-year anniversary nudge for LUNAS bookings
// whose paket returnDate was ~365d ago. Logical extension of S293
// post-departure re-engage (which fires at ~30d).
//
// The umroh agency's biggest source of repeat customers is the
// one-year mark — jemaah remember the trip, talk about it with family,
// and start thinking about going again. This nudge times the touch to
// that emotional moment.
//
// **Once-per-booking terminal cooldown** via the Notification table
// (search by relatedEntityId=bookingId, type ANNIVERSARY_REENGAGE).
// Each jemaah hears from us at most once for each completed trip.
//
// Engagement opt-out (S309) enforced at query level via
// `jemaah.notifEngagement = true` filter.
//
// Window: returnDate ∈ [now-368d, now-362d] gives a ±3d band around
// the 365d mark to absorb cron-misses.

import { db } from '../lib/db.js';

const DEFAULT_DAYS_BACK_MIN = 362;
const DEFAULT_DAYS_BACK_MAX = 368;

export async function getAnniversaryCandidates({
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
      jemaah: { notifEngagement: true },
    },
    select: {
      id: true, bookingNo: true, jemaahUserId: true,
      paket: { select: { id: true, slug: true, title: true, returnDate: true } },
      jemaah: { select: { id: true, fullName: true, phone: true, email: true } },
    },
  });
  if (bookings.length === 0) return [];

  // Terminal cooldown — skip any booking that's already had an anniversary
  // ping. (Even after the ±3-day window, this guard prevents the rare
  // edge case where calendar drift would re-fire on day 369.)
  const ids = bookings.map((b) => b.id);
  const prior = await db.notification.findMany({
    where: {
      type: 'ANNIVERSARY_REENGAGE',
      relatedEntity: 'Booking',
      relatedEntityId: { in: ids },
    },
    select: { relatedEntityId: true },
  });
  const sentFor = new Set(prior.map((p) => p.relatedEntityId));
  return bookings.filter((b) => !sentFor.has(b.id));
}

export async function sendAnniversaryReengage({
  now = new Date(),
  daysBackMin = DEFAULT_DAYS_BACK_MIN,
  daysBackMax = DEFAULT_DAYS_BACK_MAX,
} = {}) {
  const candidates = await getAnniversaryCandidates({ now, daysBackMin, daysBackMax });
  if (candidates.length === 0) {
    return { candidateCount: 0, enqueued: 0, skipped: 0 };
  }

  // Top 3 active future paket so the nudge has a CTA. Same pattern as
  // S293 — empty list silently omits the list section.
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
    ? '\n\nKalau Anda mempertimbangkan umroh kedua, ini paket terdekat kami:\n'
      + futurePaket.map((p) => `  • ${p.title} · berangkat ${p.departureDate.toISOString().slice(0, 10)} · /p/${p.slug}`).join('\n')
    : '';

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const b of candidates) {
    const j = b.jemaah;
    if (!j || (!j.email && !j.phone)) { skipped += 1; continue; }
    const firstName = (j.fullName || 'Jemaah').split(/\s+/)[0];
    const subject = `Setahun lalu Anda menyelesaikan ${b.paket.title}`;
    const body = [
      `Assalamu'alaikum ${j.fullName},`,
      '',
      `Hari ini setahun lalu Anda kembali dari ${b.paket.title}.`,
      'Kami berdoa semoga umroh Anda diterima dan kebaikannya menetap',
      'sampai sekarang.',
      nextTripsLine,
      '',
      'Terima kasih sudah memberi kami kepercayaan setahun yang lalu.',
      'Jika niat berangkat kembali datang, balas pesan ini — kami senang',
      'membantu lagi dengan paket yang sesuai untuk Anda.',
      '',
      `— Religio Pro untuk ${firstName}`,
    ].join('\n');
    const channel = j.email ? 'EMAIL' : 'WA';
    const recipient = j.email ? { recipientEmail: j.email } : { recipientPhone: j.phone };
    try {
      const r = await enqueueNotification({
        type: 'ANNIVERSARY_REENGAGE', channel,
        ...recipient,
        recipientUserId: b.jemaahUserId || null,
        subject, body,
        payload: {
          kind: 'anniversary_reengage', bookingNo: b.bookingNo,
          paketSlug: b.paket.slug,
        },
        relatedEntity: 'Booking', relatedEntityId: b.id,
      });
      if (r && r.status !== 'SKIPPED') enqueued += 1;
      else skipped += 1;
    } catch (err) {
      console.warn(`[anniversary] booking ${b.bookingNo} failed:`, err?.message || err);
      skipped += 1;
    }
  }
  return { candidateCount: candidates.length, enqueued, skipped };
}
