// Stage 380 — first-booking nudge for new jemaah.
//
// Daily cron walks JEMAAH users that have been registered ≥7d but never
// booked (zero non-CANCELLED bookings AND zero leads owned). Sends an
// EMAIL + WA jemput-bola with 3 featured paket inline.
//
// **Terminal cooldown per user** via the Notification table — one nudge
// per user, ever. We don't want to spam jemaah that signed up but
// decided not to book; respect that intent.
//
// Respects S309 engagement opt-out (`JemaahProfile.notifEngagement`) at
// the query level so opted-out users never enter the candidate list.
// Per-channel S5jj opt-out applied automatically by `enqueueNotification`.

import { db } from '../lib/db.js';

const REGISTERED_AGE_DAYS = 7;
const MAX_PAKET_IN_BODY = 3;

/**
 * Find candidate jemaah users for the first-booking nudge.
 * Returns array of { id, email, fullName, phone, profileId }.
 */
export async function getFirstBookingNudgeCandidates({ now = new Date(), ageDays = REGISTERED_AGE_DAYS } = {}) {
  const cutoff = new Date(now.getTime() - ageDays * 86_400_000);
  // Step 1: cheap shortlist — active JEMAAH users older than cutoff, opt-in,
  // with no claimed bookings via the BookingJemaahUser relation.
  const rows = await db.user.findMany({
    where: {
      role: 'JEMAAH',
      status: 'ACTIVE',
      deletedAt: null,
      createdAt: { lte: cutoff },
      jemaah: { notifEngagement: true },
      bookings: { none: {} }, // BookingJemaahUser relation
    },
    select: {
      id: true, email: true, fullName: true, phone: true,
      jemaah: { select: { id: true, fullName: true, phone: true, email: true } },
    },
    take: 500,
  });
  if (rows.length === 0) return [];
  // Step 2: separate notif lookup for terminal cooldown — no User→Notification
  // relation in schema, so use a single batched IN query.
  const prior = await db.notification.findMany({
    where: {
      type: 'JEMAAH_FIRST_BOOKING_NUDGE',
      recipientUserId: { in: rows.map((u) => u.id) },
    },
    select: { recipientUserId: true },
  });
  const nudgedIds = new Set(prior.map((p) => p.recipientUserId));
  // Step 3: per-row exclusion via profile bookings + leads. Profile bookings
  // catches anonymous-then-claimed cases where User.bookings may be empty
  // but JemaahProfile.bookings has the row (profile-merge legacy).
  const filtered = [];
  for (const u of rows) {
    if (!u.jemaah || nudgedIds.has(u.id)) continue;
    const phone = u.phone || u.jemaah.phone || '';
    const phoneTail = phone.slice(-8);
    const [profileBookings, leadCount] = await Promise.all([
      db.booking.count({
        where: { jemaahId: u.jemaah.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
      }),
      phoneTail ? db.lead.count({
        where: {
          phone: { endsWith: phoneTail },
          status: { notIn: ['CONVERTED', 'LOST'] },
        },
      }) : Promise.resolve(0),
    ]);
    if (profileBookings > 0 || leadCount > 0) continue;
    filtered.push(u);
  }
  return filtered;
}

/**
 * Fan-out the nudge to one user. Fire-and-forget EMAIL + WA.
 * Returns { enqueued, channels } so the batch entry can count.
 */
export async function notifyFirstBookingNudge({ user, featuredPaket = [] }) {
  if (!user) return { enqueued: 0, channels: [] };
  const { enqueueNotification } = await import('./notifications.js');
  const firstName = (user.fullName || 'Jemaah').split(/\s+/)[0];
  const paketLines = featuredPaket.slice(0, MAX_PAKET_IN_BODY).map((p, i) => {
    const dep = p.departureDate ? new Date(p.departureDate).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
    return `${i + 1}. ${p.title} · berangkat ${dep} · mulai Rp ${Math.round(p.minPrice / 1000).toLocaleString('id-ID')}rb`;
  });
  const subject = `${firstName}, sudah lihat paket umroh terbaru?`;
  const body = [
    `Halo ${firstName},`,
    '',
    'Anda mendaftar di Religio Pro minggu lalu — sampai sekarang belum ada booking aktif.',
    'Tim kami siap bantu jika ada pertanyaan tentang paket, dokumen, atau pembayaran.',
    '',
    ...(paketLines.length > 0 ? ['Beberapa paket yang sedang populer:', '', ...paketLines, ''] : []),
    'Lihat semua paket: /saya/paket',
    '',
    'Kalau butuh dipandu pribadi, balas pesan ini atau WA tim CS kami.',
    '',
    '— Religio Pro',
  ].join('\n');

  let enqueued = 0;
  const channels = [];
  if (user.email) {
    try {
      await enqueueNotification({
        type: 'JEMAAH_FIRST_BOOKING_NUDGE', channel: 'EMAIL',
        recipientEmail: user.email,
        recipientUserId: user.id,
        subject, body,
        payload: { kind: 'first_booking_nudge', featuredCount: paketLines.length },
        relatedEntity: 'User', relatedEntityId: user.id,
      });
      enqueued += 1;
      channels.push('EMAIL');
    } catch (err) {
      console.warn('[firstBookingNudge] EMAIL failed:', err?.message || err);
    }
  }
  if (user.phone || user.jemaah?.phone) {
    try {
      await enqueueNotification({
        type: 'JEMAAH_FIRST_BOOKING_NUDGE', channel: 'WA',
        recipientPhone: user.phone || user.jemaah?.phone,
        recipientUserId: user.id,
        subject, body,
        payload: { kind: 'first_booking_nudge' },
        relatedEntity: 'User', relatedEntityId: user.id,
      });
      enqueued += 1;
      channels.push('WA');
    } catch (err) {
      console.warn('[firstBookingNudge] WA failed:', err?.message || err);
    }
  }
  return { enqueued, channels };
}

/**
 * Batch entry: find candidates + fan out 3 featured paket inline.
 */
export async function sendFirstBookingNudges({ now = new Date() } = {}) {
  const [candidates, paket] = await Promise.all([
    getFirstBookingNudgeCandidates({ now }),
    db.paket.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        departureDate: { gt: now },
      },
      orderBy: { departureDate: 'asc' },
      take: MAX_PAKET_IN_BODY,
      select: {
        id: true, slug: true, title: true, departureDate: true,
        prices: { select: { priceIdr: true }, orderBy: { priceIdr: 'asc' }, take: 1 },
      },
    }),
  ]);
  const featuredPaket = paket.map((p) => ({
    id: p.id, slug: p.slug, title: p.title, departureDate: p.departureDate,
    minPrice: Number(p.prices[0]?.priceIdr ?? 0),
  }));

  let enqueued = 0;
  let nudged = 0;
  let failed = 0;
  for (const u of candidates) {
    try {
      const r = await notifyFirstBookingNudge({ user: u, featuredPaket });
      enqueued += r.enqueued;
      if (r.enqueued > 0) nudged += 1;
    } catch (err) {
      console.warn('[firstBookingNudge] user failed:', u.email, err?.message || err);
      failed += 1;
    }
  }
  return { candidateCount: candidates.length, nudged, enqueued, failed };
}

export { REGISTERED_AGE_DAYS, MAX_PAKET_IN_BODY };
