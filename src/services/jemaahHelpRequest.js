// Stage 321 — jemaah SOS-light help request. When an in-trip jemaah
// needs admin attention (medical issue, lost from group, schedule
// confusion), they submit a short message via /saya. The service:
//
//   1. Validates jemaah has an active in-trip booking (mirrors S320
//      window check — no help requests pre-trip or post-trip).
//   2. Resolves admin tier (OWNER/SUPERADMIN/MANAJER_OPS) +
//      assigned crew on the paket.
//   3. Fans out EMAIL + WA per recipient. One row per
//      (recipient × channel) for independent retry.
//   4. Appends a system note on the booking + writes an audit row so
//      admin sees the request in the booking timeline.
//
// Distinct from S5ff cancel request (different intent: help vs leave)
// and crew SOS (S13: crew-side incident with state machine + queue).
// JEMAAH_HELP_REQUEST is intentionally lightweight — admin handles
// via WA/phone, no separate /admin/incidents-style queue. If the
// pattern proves heavy, a dedicated queue can be added later.

import { db } from '../lib/db.js';
import { HttpError } from '../middleware/error.js';
import { audit } from '../lib/audit.js';
import { env } from '../env.js';

const MIN_MESSAGE_LEN = 5;
const MAX_MESSAGE_LEN = 1000;
// Per-booking cooldown via Notification table query. Tunable via env var
// SOS_COOLDOWN_MIN (default 5min, clamp 0..120). 0 = no cooldown — admin-
// side push tag dedupe + queue page handle visual spam, so real-emergency
// follow-up updates aren't blocked. See env.js for rationale.

async function findInTripBooking(userId, now = new Date()) {
  const candidates = await db.booking.findMany({
    where: { jemaahUserId: userId, status: 'LUNAS' },
    select: {
      id: true, bookingNo: true, paketId: true,
      paket: { select: { id: true, slug: true, title: true, departureDate: true, returnDate: true } },
      jemaah: { select: { fullName: true, phone: true, email: true } },
    },
  });
  const localMidnight = (d) => {
    const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
  };
  const today = localMidnight(now).getTime();
  for (const b of candidates) {
    const p = b.paket;
    if (!p) continue;
    const dep = localMidnight(p.departureDate).getTime();
    const ret = localMidnight(p.returnDate).getTime();
    if (today >= dep && today <= ret) return b;
  }
  return null;
}

/**
 * Submit a help request. Returns `{ enqueued, recipients }`.
 *
 * Throws:
 *   400 BAD_MESSAGE — message too short / missing
 *   409 NOT_IN_TRIP — no active in-trip booking found for this user
 *   429 RATE_LIMITED — prior help request within env.SOS_COOLDOWN_MIN window
 */
// Stage 358 — sanitise a best-effort geolocation payload from the SOS form.
// Browsers return { latitude, longitude, accuracy }; we accept the same
// shape, validate ranges + drop garbage so payload stays clean. Returns
// null on any failure — geolocation is opt-in (jemaah may decline the
// permission prompt) so missing data must never block the SOS.
function normaliseLocation(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const lat = Number(loc.latitude);
  const lng = Number(loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const out = { latitude: lat, longitude: lng };
  const acc = Number(loc.accuracy);
  if (Number.isFinite(acc) && acc > 0) out.accuracyMeters = Math.round(acc);
  return out;
}

export async function submitJemaahHelpRequest({ req, actor, userId, message, location = null, now = new Date() }) {
  const trimmed = String(message || '').trim().slice(0, MAX_MESSAGE_LEN);
  if (trimmed.length < MIN_MESSAGE_LEN) {
    throw new HttpError(400, `Pesan bantuan minimal ${MIN_MESSAGE_LEN} karakter`, 'BAD_MESSAGE');
  }
  // S358 — best-effort geolocation. Missing/invalid → null, no error.
  const loc = normaliseLocation(location);
  const booking = await findInTripBooking(userId, now);
  if (!booking) {
    throw new HttpError(409, 'Hanya jemaah dalam perjalanan yang bisa kirim SOS', 'NOT_IN_TRIP');
  }
  // Cooldown check — search prior JEMAAH_HELP_REQUEST notif for this booking.
  // Skip entirely when SOS_COOLDOWN_MIN=0 (admin opted out of cooldown).
  const cooldownMin = env.SOS_COOLDOWN_MIN;
  if (cooldownMin > 0) {
    const cutoff = new Date(now.getTime() - cooldownMin * 60_000);
    const prior = await db.notification.findFirst({
      where: {
        type: 'JEMAAH_HELP_REQUEST',
        relatedEntity: 'Booking', relatedEntityId: booking.id,
        createdAt: { gte: cutoff },
      },
      select: { id: true, createdAt: true },
    });
    if (prior) {
      const elapsedMin = Math.floor((now.getTime() - prior.createdAt.getTime()) / 60_000);
      const waitMin = Math.max(1, cooldownMin - elapsedMin);
      throw new HttpError(429, `Terlalu cepat — tunggu ${waitMin} menit sebelum SOS lagi`, 'RATE_LIMITED');
    }
  }

  // Resolve recipients: ACTIVE admin tier + assigned MUTHAWWIF crew on paket
  const [admins, crews] = await Promise.all([
    db.user.findMany({
      where: {
        role: { in: ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'] },
        status: 'ACTIVE', deletedAt: null,
      },
      select: { id: true, email: true, phone: true, fullName: true },
    }),
    db.paketCrew.findMany({
      where: { paketId: booking.paketId },
      select: {
        user: {
          select: {
            id: true, email: true, phone: true, fullName: true,
            status: true, deletedAt: true,
          },
        },
      },
    }),
  ]);
  const crewUsers = crews
    .map((c) => c.user)
    .filter((u) => u && u.status === 'ACTIVE' && !u.deletedAt);
  // Dedup by user id (admin who is also assigned crew gets one fan-out)
  const seen = new Set();
  const recipients = [];
  for (const u of [...admins, ...crewUsers]) {
    if (!u || seen.has(u.id)) continue;
    seen.add(u.id);
    recipients.push(u);
  }

  const { enqueueNotification } = await import('./notifications.js');
  const j = booking.jemaah;
  const subject = `🆘 Bantuan diminta · ${j?.fullName || 'jemaah'} · ${booking.paket.title}`;
  // S358 — inline lokasi line + Maps deep link when GPS captured. Drops
  // cleanly when location absent (jemaah declined the prompt or the
  // capture timed out — admin still gets the SOS, just without GPS).
  const locLines = loc ? [
    '',
    '— LOKASI (GPS jemaah)',
    `Koordinat : ${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}`,
    `Akurasi   : ±${loc.accuracyMeters || '?'} m`,
    `Maps      : https://maps.google.com/?q=${loc.latitude},${loc.longitude}`,
  ] : [];
  const body = [
    `Jemaah dalam perjalanan menekan tombol SOS-light.`,
    '',
    `Jemaah  : ${j?.fullName || '—'}`,
    `Phone   : ${j?.phone || '—'}`,
    `Email   : ${j?.email || '—'}`,
    `Paket   : ${booking.paket.title}`,
    `Booking : ${booking.bookingNo}`,
    '',
    '— PESAN',
    trimmed,
    ...locLines,
    '',
    'Mohon hubungi jemaah sesegera mungkin via WA/telepon.',
    '',
    `Detail booking: /admin/bookings/${booking.id}`,
    '',
    '— sistem Religio Pro',
  ].join('\n');

  // S148 — set recipientUserId for CREW recipients so the row surfaces in
  // their /crew/notifications inbox (per-user filter). Admin rows keep
  // recipientUserId=null because admin has no per-user inbox surface —
  // they read SOS via /admin/help-requests queue + global notif viewer.
  const adminIdSet = new Set(admins.map((a) => a.id));
  let enqueued = 0;
  for (const u of recipients) {
    const isCrew = !adminIdSet.has(u.id);
    for (const channel of ['EMAIL', 'WA']) {
      const recipient = channel === 'EMAIL'
        ? (u.email ? { recipientEmail: u.email } : null)
        : (u.phone ? { recipientPhone: u.phone } : null);
      if (!recipient) continue;
      try {
        await enqueueNotification({
          type: 'JEMAAH_HELP_REQUEST', channel,
          ...recipient,
          recipientUserId: isCrew ? u.id : null,
          subject, body,
          payload: {
            kind: 'jemaah_help_request',
            bookingNo: booking.bookingNo,
            jemaahName: j?.fullName, jemaahPhone: j?.phone,
            messagePreview: trimmed.slice(0, 200),
            // S358 — admin SOS banner reads this to render the Maps link
            location: loc,
          },
          relatedEntity: 'Booking', relatedEntityId: booking.id,
        });
        enqueued += 1;
      } catch (err) {
        console.warn(`[jemaahHelpRequest] ${channel} failed for ${u.email || u.phone}:`, err?.message || err);
      }
    }
  }

  // Web push fan-out — real-time toast on installed PWA. Mirrors the
  // admin-incident pushToAdmins pattern (S17) for jemaah SOS so crew
  // and admin get the alert immediately even if EMAIL/WA queue lags.
  // SOS-tagged so SW handler keeps the notification sticky (S352).
  // Best-effort: push failure logs but never aborts the SOS write.
  try {
    const { pushToUser } = await import('./webPush.js');
    const adminIds = new Set(admins.map((a) => a.id));
    const pushTitle = `🆘 SOS dari ${j?.fullName || 'jemaah'}`;
    const pushBody = trimmed.slice(0, 140);
    const pushTag = `sos-${booking.id}`;
    const crewSlug = booking.paket?.slug;
    for (const u of recipients) {
      const isAdmin = adminIds.has(u.id);
      const url = isAdmin
        ? '/admin/help-requests'
        : (crewSlug ? `/crew/paket/${crewSlug}` : '/crew');
      try {
        await pushToUser(u.id, {
          title: pushTitle, body: pushBody, url,
          tag: pushTag, requireInteraction: true,
        });
      } catch (err) {
        console.warn(`[jemaahHelpRequest] push failed for ${u.email || u.id}:`, err?.message || err);
      }
    }
  } catch (err) {
    console.warn('[jemaahHelpRequest] push fan-out skipped:', err?.message || err);
  }

  // Append a system note to the booking so admin sees it in the
  // timeline. Idempotent across the cooldown window because the
  // cooldown guard above blocks rapid re-submission.
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const noteAppend = `\n\n[SOS-LIGHT ${stamp}] ${trimmed}`;
  const existing = await db.booking.findUnique({
    where: { id: booking.id }, select: { notes: true },
  });
  await db.booking.update({
    where: { id: booking.id },
    data: { notes: (existing?.notes || '') + noteAppend },
  });

  await audit({
    req, actor,
    action: 'CREATE',
    entity: 'JemaahHelpRequest', entityId: booking.id,
    before: null,
    after: {
      bookingNo: booking.bookingNo,
      message: trimmed,
      recipientCount: recipients.length,
      enqueuedCount: enqueued,
      // S358 — durable audit of location attached to this SOS
      location: loc,
    },
  });

  return { booking, enqueued, recipients: recipients.length, location: loc };
}

// ── Stage 325 — admin ACK loop ───────────────────────────────

/**
 * Returns the booking's pending-help-request state used by the admin UI:
 *   { pending: bool, lastRequestAt, lastRequestPreview, ackedAt, ackedByEmail }
 *
 * Pending = latest JEMAAH_HELP_REQUEST is newer than latest JEMAAH_HELP_ACK.
 * Used by /admin/bookings/:id to decide whether to show the "ACK SOS"
 * button + by analytics surfaces.
 */
export async function getBookingHelpRequestState({ bookingId }) {
  if (!bookingId) return { pending: false };
  const [latestReq, latestAck] = await Promise.all([
    db.notification.findFirst({
      where: {
        type: 'JEMAAH_HELP_REQUEST',
        relatedEntity: 'Booking', relatedEntityId: bookingId,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, payload: true },
    }),
    db.notification.findFirst({
      where: {
        type: 'JEMAAH_HELP_ACK',
        relatedEntity: 'Booking', relatedEntityId: bookingId,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, payload: true },
    }),
  ]);
  if (!latestReq) return { pending: false };
  const pending = !latestAck || latestAck.createdAt < latestReq.createdAt;
  const preview = latestReq.payload?.messagePreview
    || (typeof latestReq.payload === 'object' && latestReq.payload?.messagePreview)
    || null;
  // S358 — extract location from the latest request's payload so admin
  // SOS banner can render the Maps deep link.
  const location = (latestReq.payload && typeof latestReq.payload === 'object')
    ? (latestReq.payload.location || null) : null;
  return {
    pending,
    lastRequestAt: latestReq.createdAt,
    lastRequestPreview: preview,
    location,
    ackedAt: latestAck?.createdAt || null,
    ackedByEmail: latestAck?.payload?.ackedByEmail || null,
  };
}

/**
 * Admin acknowledges a jemaah help request. Fires:
 *   - One EMAIL + WA per channel to jemaah (confirms tim sudah respon)
 *   - Push notif via S93 pushToUser (when jemaah has installed /saya PWA)
 *   - Booking note append: [HELP-ACK <timestamp> by <admin>]
 *   - Audit row
 *
 * Refuses (409 NO_PENDING_REQUEST) when there's no pending help request
 * — admin shouldn't ack out of thin air. Idempotent re-ack ok within
 * the loose semantics (multiple acks per request just stack the note +
 * notifs, which is acceptable: admin reassuring jemaah twice is fine).
 */
export async function ackJemaahHelpRequest({ req, actor, bookingId, message = '' }) {
  if (!bookingId) throw new HttpError(400, 'bookingId required', 'BAD_INPUT');
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNo: true, jemaahUserId: true,
      jemaah: { select: { fullName: true, phone: true, email: true } },
      paket: { select: { title: true } },
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');

  const state = await getBookingHelpRequestState({ bookingId });
  if (!state.pending) {
    throw new HttpError(409, 'Tidak ada permintaan bantuan yang menunggu', 'NO_PENDING_REQUEST');
  }

  const trimmed = String(message || '').trim().slice(0, 500);
  const firstName = (booking.jemaah?.fullName || 'Jemaah').split(/\s+/)[0];
  const subject = `Tim sudah respon SOS Anda · ${booking.bookingNo}`;
  const body = [
    `Halo ${firstName},`,
    '',
    'Permintaan bantuan Anda sudah diterima dan tim Religio Pro sedang menangani.',
    'Tim akan menghubungi Anda via WhatsApp atau telepon dalam beberapa menit.',
    ...(trimmed ? ['', 'Catatan tim:', trimmed] : []),
    '',
    'Mohon stay tenang + jangan berpindah lokasi sampai tim tiba.',
    '',
    '— Religio Pro',
  ].join('\n');

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0;
  // EMAIL
  if (booking.jemaah?.email) {
    try {
      await enqueueNotification({
        type: 'JEMAAH_HELP_ACK', channel: 'EMAIL',
        recipientEmail: booking.jemaah.email,
        recipientUserId: booking.jemaahUserId || null,
        subject, body,
        payload: {
          kind: 'jemaah_help_ack',
          bookingNo: booking.bookingNo,
          ackedByEmail: actor?.email || null,
        },
        relatedEntity: 'Booking', relatedEntityId: booking.id,
      });
      enqueued += 1;
    } catch (err) {
      console.warn('[helpAck] EMAIL failed:', err?.message || err);
    }
  }
  // WA
  if (booking.jemaah?.phone) {
    try {
      await enqueueNotification({
        type: 'JEMAAH_HELP_ACK', channel: 'WA',
        recipientPhone: booking.jemaah.phone,
        recipientUserId: booking.jemaahUserId || null,
        subject, body,
        payload: {
          kind: 'jemaah_help_ack',
          bookingNo: booking.bookingNo,
          ackedByEmail: actor?.email || null,
        },
        relatedEntity: 'Booking', relatedEntityId: booking.id,
      });
      enqueued += 1;
    } catch (err) {
      console.warn('[helpAck] WA failed:', err?.message || err);
    }
  }
  // Push to jemaah's installed /saya PWA (S93). Best-effort — push failure
  // never aborts the ack (email + WA are the load-bearing channels).
  if (booking.jemaahUserId) {
    try {
      const { pushToUser } = await import('./webPush.js');
      await pushToUser(booking.jemaahUserId, {
        title: 'Tim sudah respon SOS Anda',
        body: trimmed || 'Tim akan menghubungi Anda via WA/telepon.',
        url: `/saya/bookings/${booking.id}`,
        tag: `help-ack-${booking.id}`,
        requireInteraction: false,
      });
    } catch (err) {
      console.warn('[helpAck] push failed:', err?.message || err);
    }
  }

  // Append a system note to booking
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const noteAppend = `\n\n[HELP-ACK ${stamp}] by ${actor?.email || '—'}`
    + (trimmed ? `: ${trimmed}` : '');
  const existing = await db.booking.findUnique({
    where: { id: booking.id }, select: { notes: true },
  });
  await db.booking.update({
    where: { id: booking.id },
    data: { notes: (existing?.notes || '') + noteAppend },
  });

  await audit({
    req, actor,
    action: 'UPDATE',
    entity: 'JemaahHelpRequest', entityId: booking.id,
    before: null,
    after: {
      bookingNo: booking.bookingNo,
      ack: true,
      message: trimmed,
      enqueuedCount: enqueued,
    },
  });

  return { booking, enqueued };
}

/**
 * Stage 331 — admin queue for pending help requests across all bookings.
 * Derived from the Notification table — no separate model needed.
 *
 * "Pending" = latest JEMAAH_HELP_REQUEST notif for a booking is newer
 * than latest JEMAAH_HELP_ACK for the same booking (mirrors per-booking
 * `getBookingHelpRequestState` logic but in aggregate).
 *
 * Returns rows sorted oldest-pending first (most urgent at top) +
 * counts for the KPI strip + an `escalatedCount` for the panel header.
 */
export async function listPendingHelpRequests({ limit = 100, now = new Date() } = {}) {
  // Pull recent help requests + acks. 90-day window is generous; help
  // requests are short-lived (admin acks within hours typically) so
  // anything older than 90d is almost certainly handled or
  // historical noise.
  const since = new Date(now.getTime() - 90 * 86_400_000);
  const [requests, acks, escalations] = await Promise.all([
    db.notification.findMany({
      where: {
        type: 'JEMAAH_HELP_REQUEST',
        relatedEntity: 'Booking',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, createdAt: true, relatedEntityId: true, payload: true,
      },
    }),
    db.notification.findMany({
      where: {
        type: 'JEMAAH_HELP_ACK',
        relatedEntity: 'Booking',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, relatedEntityId: true, payload: true },
    }),
    db.notification.findMany({
      where: {
        type: 'JEMAAH_HELP_ESCALATED',
        relatedEntity: 'Booking',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, relatedEntityId: true },
    }),
  ]);

  // Reduce to per-booking latest of each type
  const latestReq = new Map();
  for (const r of requests) {
    if (!latestReq.has(r.relatedEntityId)) latestReq.set(r.relatedEntityId, r);
  }
  const latestAck = new Map();
  for (const a of acks) {
    if (!latestAck.has(a.relatedEntityId)) latestAck.set(a.relatedEntityId, a);
  }
  const latestEsc = new Map();
  for (const e of escalations) {
    if (!latestEsc.has(e.relatedEntityId)) latestEsc.set(e.relatedEntityId, e);
  }

  // Pending = latest req newer than latest ack (or no ack at all)
  const pendingIds = [];
  for (const [bookingId, req] of latestReq.entries()) {
    const ack = latestAck.get(bookingId);
    if (!ack || ack.createdAt < req.createdAt) {
      pendingIds.push(bookingId);
    }
  }
  if (pendingIds.length === 0) {
    return {
      rows: [], counts: { pending: 0, escalated: 0, ackedRecently: 0 },
    };
  }

  // Fetch the bookings + jemaah identity
  const bookings = await db.booking.findMany({
    where: { id: { in: pendingIds } },
    select: {
      id: true, bookingNo: true,
      jemaah: { select: { fullName: true, phone: true, email: true } },
      paket: { select: { slug: true, title: true } },
    },
  });
  const byId = new Map(bookings.map((b) => [b.id, b]));

  const rows = pendingIds
    .map((id) => {
      const req = latestReq.get(id);
      const booking = byId.get(id);
      if (!booking) return null;
      const ageHours = Math.round(((now.getTime() - req.createdAt.getTime()) / 3_600_000) * 10) / 10;
      const reqLocation = (req.payload && typeof req.payload === 'object')
        ? (req.payload.location || null) : null;
      return {
        bookingId: id,
        bookingNo: booking.bookingNo,
        jemaah: booking.jemaah,
        paket: booking.paket,
        requestedAt: req.createdAt,
        messagePreview: req.payload?.messagePreview || null,
        location: reqLocation, // S358
        ageHours,
        escalated: latestEsc.has(id),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.requestedAt - b.requestedAt) // oldest first
    .slice(0, limit);

  // Count recent ACKs (last 24h) for the KPI strip
  const last24h = new Date(now.getTime() - 24 * 3_600_000);
  const ackedRecently = acks.filter((a) => a.createdAt >= last24h).length;

  return {
    rows,
    counts: {
      pending: rows.length,
      escalated: rows.filter((r) => r.escalated).length,
      ackedRecently,
    },
  };
}

export { MIN_MESSAGE_LEN, MAX_MESSAGE_LEN };
