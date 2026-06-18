// Stage 318 — escalate detractor feedback that sat ≥ olderThanHours
// in NEW status (admin hasn't acked). Mirrors S80 incident escalation:
// `escalatedAt` is set-once (mode='set-only'); ack/resolve transitions
// AFTER escalation never clear it — re-escalation isn't a thing.
//
// Fan-out targets OWNER tier only (tighter than the S315 initial
// NEW-row fan-out to OWNER/SUPERADMIN/MANAJER_OPS) — we assume the
// broader admin desk already saw the first alert; this is the
// "nobody's home" louder ping for the OWNER specifically.
//
// Silent on quiet days (no candidates → no enqueues).

import { db } from '../lib/db.js';

const DEFAULT_OLDER_THAN_HOURS = 48;
const DETRACTOR_THRESHOLD = 6;

export async function getStaleDetractors({
  olderThanHours = DEFAULT_OLDER_THAN_HOURS, now = new Date(),
} = {}) {
  const cutoff = new Date(now.getTime() - olderThanHours * 3_600_000);
  return db.tripFeedback.findMany({
    where: {
      score: { lte: DETRACTOR_THRESHOLD },
      followUpStatus: 'NEW',
      escalatedAt: null,
      submittedAt: { lte: cutoff },
    },
    select: {
      id: true, score: true, comment: true, submittedAt: true,
      booking: {
        select: {
          id: true, bookingNo: true,
          jemaah: { select: { fullName: true, phone: true, email: true } },
        },
      },
      paket: { select: { title: true } },
    },
  });
}

export async function escalateStaleDetractors({
  olderThanHours = DEFAULT_OLDER_THAN_HOURS, now = new Date(),
} = {}) {
  const candidates = await getStaleDetractors({ olderThanHours, now });
  if (candidates.length === 0) return { candidateCount: 0, enqueued: 0, skipped: 0 };

  // Resolve OWNER recipients up-front; if none, mark rows escalated
  // anyway (the queue page will still show the ESCALATED badge) but
  // skip the email fan-out.
  const owners = await db.user.findMany({
    where: { role: 'OWNER', status: 'ACTIVE', deletedAt: null, email: { not: '' } },
    select: { id: true, email: true },
  });

  const { enqueueNotification } = await import('./notifications.js');
  let enqueued = 0, skipped = 0;
  for (const fb of candidates) {
    const ageHours = Math.round(((now.getTime() - fb.submittedAt.getTime()) / 3_600_000) * 10) / 10;
    const subject = `⚠⚠ Detractor belum di-handle ${ageHours}h · ${fb.booking?.bookingNo || '—'}`;
    const j = fb.booking?.jemaah;
    const body = [
      'Halo OWNER,',
      '',
      `Detractor feedback (skor ${fb.score}/10) sudah ${ageHours} jam tanpa di-ack admin.`,
      'Jemaah biasanya sudah cerita ke teman/keluarga di titik ini — recovery jadi jauh lebih sulit.',
      '',
      '— DETAIL',
      `Jemaah  : ${j?.fullName || '—'} (${j?.phone || '—'})`,
      `Email   : ${j?.email || '—'}`,
      `Paket   : ${fb.paket?.title || '—'}`,
      `Booking : ${fb.booking?.bookingNo || '—'}`,
      '',
      '— KOMENTAR',
      fb.comment && fb.comment.trim() ? fb.comment.trim() : '(jemaah tidak menulis komentar)',
      '',
      `Queue: /admin/nps/detractors`,
      '',
      '— sistem Religio Pro',
    ].join('\n');
    for (const owner of owners) {
      try {
        await enqueueNotification({
          type: 'NPS_DETRACTOR_ESCALATED', channel: 'EMAIL',
          recipientEmail: owner.email,
          // Admin-targeted — no recipientUserId per inbox rule
          subject, body,
          payload: {
            kind: 'nps_detractor_escalated', score: fb.score,
            ageHours, bookingId: fb.booking?.id,
          },
          relatedEntity: 'TripFeedback', relatedEntityId: fb.id,
        });
        enqueued += 1;
      } catch (err) {
        console.warn('[detractor-escalate] email failed:', err?.message || err);
        skipped += 1;
      }
    }
    // Set-once stamp regardless of fan-out success (the queue page
    // already shows the ESCALATED badge from this stamp; missing emails
    // are caught by the notif queue retry mechanism).
    try {
      await db.tripFeedback.update({
        where: { id: fb.id }, data: { escalatedAt: now },
      });
    } catch (err) {
      console.warn('[detractor-escalate] stamp failed:', err?.message || err);
    }
  }
  return {
    candidateCount: candidates.length, enqueued, skipped,
    ownerCount: owners.length,
  };
}

export { DEFAULT_OLDER_THAN_HOURS, DETRACTOR_THRESHOLD };
