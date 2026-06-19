// Stage 351 — daily cron: nudge jemaah whose readiness < 100% at H-7
// pre-departure. Pairs with the S349/S350 jemaah-side panels by giving
// off-portal jemaah (email/WA-only) the same signal.
//
// Window: paket.departureDate ∈ [now+5d, now+9d] gives a ±2-day band
// around H-7 to absorb cron-misses.
//
// **Per-booking 5-day cooldown** via Notification table (anti-flood:
// jemaah doesn't get the same nudge daily as deadline closes).
//
// Engagement opt-out (S309 notifEngagement) NOT enforced — this is
// transactional/operational, not marketing. Jemaah needs the heads-up
// regardless of their marketing prefs. Per-channel opt-out via S5jj
// (notifEmail/notifWa) is still honoured by enqueueNotification.

import { db } from '../lib/db.js';

const DEFAULT_DAYS_AHEAD_MIN = 5;
const DEFAULT_DAYS_AHEAD_MAX = 9;
const COOLDOWN_DAYS = 5;

export async function getReadinessReminderCandidates({
  now = new Date(),
  daysAheadMin = DEFAULT_DAYS_AHEAD_MIN,
  daysAheadMax = DEFAULT_DAYS_AHEAD_MAX,
} = {}) {
  const windowStart = new Date(now.getTime() + daysAheadMin * 86_400_000);
  const windowEnd = new Date(now.getTime() + daysAheadMax * 86_400_000);

  const bookings = await db.booking.findMany({
    where: {
      // Active bookings (any status that's not closed) — but specifically
      // LUNAS + PARTIAL + DP_PAID + BOOKED are the ones that'll actually
      // travel. PENDING bookings without payment are unlikely to fly so
      // skip the noise. CANCELLED/REFUNDED/RESCHEDULED already excluded.
      status: { in: ['BOOKED', 'DP_PAID', 'PARTIAL', 'LUNAS'] },
      paket: {
        deletedAt: null,
        departureDate: { gte: windowStart, lte: windowEnd },
      },
    },
    select: {
      id: true, bookingNo: true, roomId: true, jemaahUserId: true,
      paket: {
        select: {
          id: true, slug: true, title: true, departureDate: true,
          requiredDocs: true,
        },
      },
      jemaah: {
        select: {
          id: true, fullName: true, phone: true, email: true,
          passportNo: true, passportExpiry: true, emergencyContact: true,
          documents: { select: { type: true, status: true } },
        },
      },
    },
  });

  if (bookings.length === 0) return [];

  // Reuse S23 checklist logic to compute readiness per booking
  const { computeReadinessForBooking, resolveRequiredDocs } = await import('./preDepartureChecklist.js');
  const candidates = bookings
    .map((b) => {
      try {
        const requiredDocs = resolveRequiredDocs(b.paket.requiredDocs);
        const readiness = computeReadinessForBooking({
          booking: b, departureDate: b.paket.departureDate, requiredDocs,
        });
        return { booking: b, readiness };
      } catch (err) {
        console.warn('[predeparture-readiness] compute failed for', b.bookingNo, err?.message || err);
        return null;
      }
    })
    .filter(Boolean)
    // Only nudge bookings with < 100% readiness — fully-ready jemaah
    // don't need a "you're missing X" email
    .filter((c) => c.readiness.score < 100);
  if (candidates.length === 0) return [];

  // Per-booking cooldown
  const ids = candidates.map((c) => c.booking.id);
  const cutoff = new Date(now.getTime() - COOLDOWN_DAYS * 86_400_000);
  const prior = await db.notification.findMany({
    where: {
      type: 'PREDEPARTURE_READINESS_REMINDER',
      relatedEntity: 'Booking',
      relatedEntityId: { in: ids },
      createdAt: { gte: cutoff },
    },
    select: { relatedEntityId: true },
  });
  const sentFor = new Set(prior.map((p) => p.relatedEntityId));
  return candidates.filter((c) => !sentFor.has(c.booking.id));
}

export async function sendReadinessReminders({ now = new Date() } = {}) {
  const candidates = await getReadinessReminderCandidates({ now });
  if (candidates.length === 0) return { candidateCount: 0, enqueued: 0, skipped: 0 };

  const { enqueueNotification } = await import('./notifications.js');
  // Same labels as S350 view
  const checkLabels = {
    passportPresent: 'Nomor paspor',
    passportValid: 'Masa berlaku paspor (≥ 6 bulan setelah berangkat)',
    visaUmroh: 'Visa umroh',
    vaccineMeningitis: 'Vaksin meningitis',
    healthCert: 'Surat keterangan sehat',
    manasikCert: 'Sertifikat manasik',
    marriageCert: 'Akta nikah',
    familyCard: 'Kartu keluarga',
    otherDoc: 'Dokumen tambahan',
    roomAssigned: 'Kamar (admin yang assign — bukan jemaah)',
    emergencyContact: 'Kontak darurat',
  };
  let enqueued = 0, skipped = 0;
  for (const c of candidates) {
    const { booking: b, readiness } = c;
    const j = b.jemaah;
    if (!j || (!j.email && !j.phone)) { skipped += 1; continue; }
    const missing = Object.entries(readiness.checks)
      .filter(([, v]) => !v).map(([k]) => k);
    const daysLeft = Math.ceil(
      (new Date(b.paket.departureDate).getTime() - now.getTime()) / 86_400_000,
    );
    const firstName = (j.fullName || 'Jemaah').split(/\s+/)[0];
    const subject = `H-${daysLeft} · masih ada yang perlu dilengkapi · ${b.paket.title}`;
    const body = [
      `Assalamu'alaikum ${firstName},`,
      '',
      `Tanggal keberangkatan Anda ke ${b.paket.title} tinggal ${daysLeft} hari lagi.`,
      `Berdasarkan data kami, kesiapan dokumen Anda: ${readiness.passed}/${readiness.total} (${readiness.score}%).`,
      '',
      '— YANG MASIH KURANG',
      ...missing.map((k) => `  • ${checkLabels[k] || k}`),
      '',
      `Lengkapi via portal: /saya/bookings/${b.id}`,
      '',
      missing.includes('roomAssigned') ? '(Catatan: kamar diatur admin, bukan jemaah. Yang ini tunggu admin assign.)' : '',
      'Jika ada kendala, hubungi admin Religio Pro langsung.',
      '',
      '— Religio Pro',
    ].filter((l) => l !== '').join('\n');
    for (const channel of ['EMAIL', 'WA']) {
      const recipient = channel === 'EMAIL'
        ? (j.email ? { recipientEmail: j.email } : null)
        : (j.phone ? { recipientPhone: j.phone } : null);
      if (!recipient) continue;
      try {
        const r = await enqueueNotification({
          type: 'PREDEPARTURE_READINESS_REMINDER', channel,
          ...recipient,
          recipientUserId: b.jemaahUserId || null,
          subject, body,
          payload: {
            kind: 'predeparture_readiness',
            bookingNo: b.bookingNo,
            score: readiness.score, total: readiness.total,
            missing,
            daysLeft,
          },
          relatedEntity: 'Booking', relatedEntityId: b.id,
        });
        if (r && r.status !== 'SKIPPED') enqueued += 1;
        else skipped += 1;
      } catch (err) {
        console.warn(`[predeparture-readiness] ${channel} failed for ${b.bookingNo}:`, err?.message || err);
        skipped += 1;
      }
    }
    // Best-effort push for installed PWA
    if (b.jemaahUserId) {
      try {
        const { pushToUser } = await import('./webPush.js');
        await pushToUser(b.jemaahUserId, {
          title: `H-${daysLeft} · siap berangkat?`,
          body: `${missing.length} item belum lengkap. Tap untuk cek.`,
          url: `/saya/bookings/${b.id}`,
          tag: `predep-${b.id}`,
        });
      } catch (err) {
        console.warn('[predeparture-readiness] push failed:', err?.message || err);
      }
    }
  }
  return { candidateCount: candidates.length, enqueued, skipped };
}

export { COOLDOWN_DAYS, DEFAULT_DAYS_AHEAD_MIN, DEFAULT_DAYS_AHEAD_MAX };
