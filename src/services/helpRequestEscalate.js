// Stage 332 — escalate jemaah help requests that sat unacked > 2 hours.
//
// Pending = latest JEMAAH_HELP_REQUEST for a booking is newer than
// latest JEMAAH_HELP_ACK AND latest JEMAAH_HELP_ESCALATED. The
// JEMAAH_HELP_ESCALATED notif row itself doubles as the "already
// escalated" stamp — once present, re-runs skip the booking (set-once
// pattern, mirrors S80 incident escalation + S318 detractor escalation).
//
// Fan-out targets OWNER tier ONLY (tighter than the S321 initial
// fan-out to OWNER/SUPERADMIN/MANAJER_OPS + assigned crew) — we assume
// the broader desk already saw the first SOS; this is the "nobody's
// home" louder ping for the OWNER specifically.
//
// Silent on quiet days. Best-effort posture — per-row notif failure
// logs but doesn't abort the rest of the batch. The escalation notif
// itself is the durable stamp; missing fan-out emails are caught by
// the notif queue retry mechanism.

import { db } from '../lib/db.js';

const DEFAULT_OLDER_THAN_HOURS = 2;

export async function getStaleHelpRequests({
  olderThanHours = DEFAULT_OLDER_THAN_HOURS, now = new Date(),
} = {}) {
  // Look back 14 days — anything older is almost certainly handled or
  // historical noise; 14d also gives the cron room to catch missed
  // runs (server downtime).
  const since = new Date(now.getTime() - 14 * 86_400_000);
  const cutoff = new Date(now.getTime() - olderThanHours * 3_600_000);

  const [requests, acks, escalations] = await Promise.all([
    db.notification.findMany({
      where: {
        type: 'JEMAAH_HELP_REQUEST',
        relatedEntity: 'Booking',
        createdAt: { gte: since, lt: cutoff },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, relatedEntityId: true, payload: true },
    }),
    db.notification.findMany({
      where: {
        type: 'JEMAAH_HELP_ACK',
        relatedEntity: 'Booking',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, relatedEntityId: true },
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
  if (requests.length === 0) return [];

  // Reduce to latest-per-booking for each type
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

  const candidateIds = [];
  for (const [bookingId, req] of latestReq.entries()) {
    const ack = latestAck.get(bookingId);
    const esc = latestEsc.get(bookingId);
    // Skip if already acked AFTER the latest request
    if (ack && ack.createdAt >= req.createdAt) continue;
    // Skip if already escalated AFTER the latest request (set-once)
    if (esc && esc.createdAt >= req.createdAt) continue;
    candidateIds.push(bookingId);
  }
  if (candidateIds.length === 0) return [];

  const bookings = await db.booking.findMany({
    where: { id: { in: candidateIds } },
    select: {
      id: true, bookingNo: true,
      jemaah: { select: { fullName: true, phone: true, email: true } },
      paket: { select: { title: true } },
    },
  });
  const byId = new Map(bookings.map((b) => [b.id, b]));
  return candidateIds
    .map((id) => {
      const req = latestReq.get(id);
      const booking = byId.get(id);
      if (!booking) return null;
      return {
        bookingId: id,
        bookingNo: booking.bookingNo,
        jemaah: booking.jemaah,
        paket: booking.paket,
        requestedAt: req.createdAt,
        messagePreview: req.payload?.messagePreview || null,
        ageHours: Math.round(((now.getTime() - req.createdAt.getTime()) / 3_600_000) * 10) / 10,
      };
    })
    .filter(Boolean);
}

export async function escalateStaleHelpRequests({
  olderThanHours = DEFAULT_OLDER_THAN_HOURS, now = new Date(),
} = {}) {
  const candidates = await getStaleHelpRequests({ olderThanHours, now });
  if (candidates.length === 0) return { candidateCount: 0, enqueued: 0, skipped: 0 };

  const owners = await db.user.findMany({
    where: { role: 'OWNER', status: 'ACTIVE', deletedAt: null, email: { not: '' } },
    select: { email: true },
  });

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const c of candidates) {
    const j = c.jemaah;
    const subject = `⚠⚠ SOS belum di-handle ${c.ageHours}h · ${c.bookingNo}`;
    const body = [
      'Halo OWNER,',
      '',
      `Permintaan bantuan jemaah sudah ${c.ageHours} jam tanpa ACK admin.`,
      'Jemaah dalam perjalanan biasanya butuh respons cepat — escalation kemungkinan diperlukan.',
      '',
      '— DETAIL',
      `Jemaah  : ${j?.fullName || '—'} (${j?.phone || '—'})`,
      `Email   : ${j?.email || '—'}`,
      `Paket   : ${c.paket?.title || '—'}`,
      `Booking : ${c.bookingNo}`,
      '',
      '— PESAN',
      c.messagePreview || '(tanpa preview pesan)',
      '',
      `Queue: /admin/help-requests`,
      `Detail: /admin/bookings/${c.bookingId}`,
      '',
      '— sistem Religio Pro',
    ].join('\n');

    for (const owner of owners) {
      try {
        await enqueueNotification({
          type: 'JEMAAH_HELP_ESCALATED', channel: 'EMAIL',
          recipientEmail: owner.email,
          // Admin-targeted — no recipientUserId per inbox rule
          subject, body,
          payload: {
            kind: 'jemaah_help_escalated',
            bookingNo: c.bookingNo,
            ageHours: c.ageHours,
            messagePreview: c.messagePreview,
          },
          relatedEntity: 'Booking', relatedEntityId: c.bookingId,
        });
        enqueued += 1;
      } catch (err) {
        console.warn('[help-escalate] email failed:', err?.message || err);
        skipped += 1;
      }
    }
    // The JEMAAH_HELP_ESCALATED notif row itself is the set-once stamp.
    // If owners list is empty, we still write a marker notif so the
    // cron doesn't keep re-flagging this booking.
    if (owners.length === 0) {
      try {
        await enqueueNotification({
          type: 'JEMAAH_HELP_ESCALATED', channel: 'EMAIL',
          recipientEmail: 'noop@religio.local', // placeholder marker
          subject, body,
          payload: { kind: 'jemaah_help_escalated_marker', bookingNo: c.bookingNo },
          relatedEntity: 'Booking', relatedEntityId: c.bookingId,
        });
      } catch (err) { console.warn('[help-escalate] marker write failed:', err?.message || err); }
    }
  }
  return {
    candidateCount: candidates.length, enqueued, skipped,
    ownerCount: owners.length,
  };
}

export { DEFAULT_OLDER_THAN_HOURS };
