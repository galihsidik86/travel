// Stage 310-312 — jemaah trip feedback (NPS) service.
//
// One row per booking (TripFeedback.bookingId is @unique). Re-submit
// upserts in place so a jemaah who wants to revise their score after
// reflection can do so. Score 0-10 (NPS scale).
//
// NPS buckets (industry-standard):
//   9-10 → promoter (would actively recommend)
//   7-8  → passive  (satisfied but unlikely to evangelise)
//   0-6  → detractor (would discourage)
// %NPS = %promoters − %detractors  ·  range [-100, +100]
//
// Aggregation excludes paket with sample < MIN_SAMPLE (default 5) so
// one bad review on a niche paket doesn't drag the overall NPS into
// pseudo-noise.

import { db } from '../lib/db.js';
import { HttpError } from '../middleware/error.js';
import { audit } from '../lib/audit.js';

const MIN_SAMPLE = 5;
const MAX_COMMENT_LEN = 2000;
// S316 — only detractor rows (score ≤6) participate in the follow-up
// workflow. Promoter/passive rows stay at NEW forever (filtered out of
// the queue page; no admin action required).
const DETRACTOR_THRESHOLD = 6;
const FOLLOWUP_NOTE_MIN = 3;
const FOLLOWUP_NOTE_MAX = 2000;

function bucketFor(score) {
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

/**
 * Jemaah submits (or re-submits) feedback for ONE of their bookings.
 * Ownership is enforced upstream (route uses `jemaahUserId` filter via
 * getMyBooking), but we also re-verify here defensively.
 *
 * Constraints:
 *   - score must be integer 0-10
 *   - booking must be LUNAS (incomplete trips can't be reviewed)
 *   - booking must belong to userId
 *   - paket.returnDate must have passed (no future-trip reviews)
 */
export async function submitTripFeedback({ userId, bookingId, score, comment }) {
  if (!userId || !bookingId) {
    throw new HttpError(400, 'userId + bookingId required', 'BAD_INPUT');
  }
  const intScore = Number.parseInt(score, 10);
  if (!Number.isFinite(intScore) || intScore < 0 || intScore > 10) {
    throw new HttpError(400, 'Skor harus 0-10', 'BAD_SCORE');
  }
  const trimmed = comment == null
    ? null
    : String(comment).trim().slice(0, MAX_COMMENT_LEN);
  const finalComment = trimmed && trimmed.length > 0 ? trimmed : null;

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, status: true, jemaahUserId: true, paketId: true,
      paket: { select: { id: true, returnDate: true } },
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  // 404 (not 403) so cross-user access doesn't leak booking existence.
  if (booking.jemaahUserId !== userId) {
    throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  }
  if (booking.status !== 'LUNAS') {
    throw new HttpError(409, 'Hanya booking LUNAS yang bisa direview', 'BOOKING_NOT_LUNAS');
  }
  if (!booking.paket?.returnDate || new Date(booking.paket.returnDate) > new Date()) {
    throw new HttpError(409, 'Paket belum kembali — review hanya setelah kepulangan', 'PAKET_NOT_RETURNED');
  }

  const row = await db.tripFeedback.upsert({
    where: { bookingId },
    update: { score: intScore, comment: finalComment, submittedAt: new Date() },
    create: {
      bookingId, paketId: booking.paketId,
      score: intScore, comment: finalComment,
    },
  });

  // S315 — detractor alert (best-effort; never aborts the feedback write).
  if (intScore <= 4) {
    try {
      const enriched = await db.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true, bookingNo: true,
          jemaah: { select: { fullName: true, phone: true, email: true } },
          paket: { select: { title: true } },
        },
      });
      const { notifyNpsDetractorAlert } = await import('./notifications.js');
      await notifyNpsDetractorAlert({
        feedback: row,
        booking: enriched,
        jemaah: enriched?.jemaah,
        paket: enriched?.paket,
      });
    } catch (err) {
      console.warn('[tripFeedback] detractor alert failed:', err?.message || err);
    }
  }
  return row;
}

/**
 * Read a jemaah's existing feedback for a booking (used by the survey
 * page to pre-fill on revisit). Cross-user access returns null so the
 * form just renders empty rather than leaking info.
 */
export async function getMyTripFeedback({ userId, bookingId }) {
  if (!userId || !bookingId) return null;
  const row = await db.tripFeedback.findUnique({
    where: { bookingId },
    include: {
      booking: { select: { jemaahUserId: true } },
    },
  });
  if (!row || row.booking?.jemaahUserId !== userId) return null;
  return {
    id: row.id, score: row.score, comment: row.comment, submittedAt: row.submittedAt,
  };
}

/**
 * Global NPS rollup over a trailing window (default 365d). Returns
 * overall NPS + per-paket breakdown with sample-size guards.
 */
export async function getNpsRollup({ days = 365, now = new Date(), minSample = MIN_SAMPLE } = {}) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const rows = await db.tripFeedback.findMany({
    where: { submittedAt: { gte: cutoff } },
    select: {
      score: true, paketId: true,
      paket: { select: { slug: true, title: true } },
    },
  });
  const total = rows.length;
  if (total === 0) {
    return {
      days, total: 0,
      overall: { promoters: 0, passives: 0, detractors: 0, npsPct: null },
      perPaket: [],
      recentComments: [],
    };
  }
  let prom = 0, pas = 0, det = 0;
  const byPaket = new Map();
  for (const r of rows) {
    const b = bucketFor(r.score);
    if (b === 'promoter') prom += 1;
    else if (b === 'passive') pas += 1;
    else det += 1;
    if (r.paketId) {
      const key = r.paketId;
      const cur = byPaket.get(key) || {
        paketId: key,
        paketSlug: r.paket?.slug || null,
        paketTitle: r.paket?.title || '(paket terhapus)',
        prom: 0, pas: 0, det: 0, total: 0, sum: 0,
      };
      cur.total += 1;
      cur.sum += r.score;
      if (b === 'promoter') cur.prom += 1;
      else if (b === 'passive') cur.pas += 1;
      else cur.det += 1;
      byPaket.set(key, cur);
    }
  }
  const overallNps = Math.round(((prom - det) / total) * 1000) / 10;

  const perPaket = [...byPaket.values()].map((p) => {
    const enough = p.total >= minSample;
    const npsPct = enough
      ? Math.round(((p.prom - p.det) / p.total) * 1000) / 10
      : null;
    return {
      paketId: p.paketId,
      paketSlug: p.paketSlug,
      paketTitle: p.paketTitle,
      total: p.total,
      promoters: p.prom, passives: p.pas, detractors: p.det,
      avgScore: Math.round((p.sum / p.total) * 10) / 10,
      npsPct, lowSample: !enough,
    };
  });
  // Sort: enough-sample rows first by npsPct desc, then by total desc;
  // low-sample rows after sorted by total desc (so admin sees the
  // closest-to-being-actionable rows at the top of the dimmed group).
  perPaket.sort((a, b) => {
    if (a.lowSample !== b.lowSample) return a.lowSample ? 1 : -1;
    if (!a.lowSample) return (b.npsPct ?? 0) - (a.npsPct ?? 0);
    return b.total - a.total;
  });

  // Recent comments (last 10, non-empty) so admin can read raw voice.
  const recentRows = await db.tripFeedback.findMany({
    where: { submittedAt: { gte: cutoff }, comment: { not: null } },
    orderBy: { submittedAt: 'desc' },
    take: 10,
    select: {
      score: true, comment: true, submittedAt: true,
      paket: { select: { slug: true, title: true } },
      booking: { select: { jemaah: { select: { fullName: true } } } },
    },
  });
  const recentComments = recentRows.map((r) => ({
    score: r.score,
    comment: r.comment,
    submittedAt: r.submittedAt,
    paketTitle: r.paket?.title || null,
    paketSlug: r.paket?.slug || null,
    jemaahName: r.booking?.jemaah?.fullName || 'Anonim',
    bucket: bucketFor(r.score),
  }));

  return {
    days, total,
    overall: { promoters: prom, passives: pas, detractors: det, npsPct: overallNps },
    perPaket,
    recentComments,
  };
}

// ── Stage 316: detractor follow-up lifecycle ─────────────────────

/**
 * Allowed status transitions. NEW can flow to ACKED or RESOLVED (skip
 * ack when admin closes immediately); ACKED can flow to RESOLVED or
 * UNREACHABLE. RESOLVED + UNREACHABLE are terminal.
 */
const ALLOWED_TRANSITIONS = {
  NEW:         new Set(['ACKED', 'RESOLVED', 'UNREACHABLE']),
  ACKED:       new Set(['RESOLVED', 'UNREACHABLE']),
  RESOLVED:    new Set([]),
  UNREACHABLE: new Set([]),
};

/**
 * Internal: validate target status + run transition write + write
 * audit row. Returns the updated row. Reused by ack/resolve/unreachable
 * shorthand exports below.
 *
 * `noteRequired` controls whether followUpNote must be non-empty —
 * RESOLVED + UNREACHABLE need a reason; ACKED is just acknowledgement.
 */
async function transitionFollowUp({
  req, actor, feedbackId, toStatus, note, noteRequired = false,
}) {
  if (!feedbackId) throw new HttpError(400, 'feedbackId required', 'BAD_INPUT');
  if (!ALLOWED_TRANSITIONS[toStatus]) {
    throw new HttpError(400, 'Invalid target status', 'BAD_STATUS');
  }
  const trimmedNote = note == null ? null : String(note).trim().slice(0, FOLLOWUP_NOTE_MAX);
  if (noteRequired && (!trimmedNote || trimmedNote.length < FOLLOWUP_NOTE_MIN)) {
    throw new HttpError(400, `Catatan tindak lanjut minimal ${FOLLOWUP_NOTE_MIN} karakter`, 'NOTE_REQUIRED');
  }
  const before = await db.tripFeedback.findUnique({
    where: { id: feedbackId },
    select: {
      id: true, score: true, followUpStatus: true,
      followUpNote: true, followedUpAt: true, followedUpByEmail: true,
      bookingId: true,
    },
  });
  if (!before) throw new HttpError(404, 'Feedback tidak ditemukan', 'FEEDBACK_NOT_FOUND');
  if (before.score > DETRACTOR_THRESHOLD) {
    throw new HttpError(409, 'Hanya feedback detractor (skor ≤6) yang punya follow-up', 'NOT_DETRACTOR');
  }
  if (!ALLOWED_TRANSITIONS[before.followUpStatus].has(toStatus)) {
    throw new HttpError(
      409,
      `Tidak bisa transisi dari ${before.followUpStatus} ke ${toStatus}`,
      'BAD_TRANSITION',
    );
  }
  const now = new Date();
  const updated = await db.tripFeedback.update({
    where: { id: feedbackId },
    data: {
      followUpStatus: toStatus,
      // Preserve existing note when admin doesn't pass one (ACKED case);
      // overwrite when they do (RESOLVED/UNREACHABLE supply a closing
      // reason).
      ...(trimmedNote != null ? { followUpNote: trimmedNote } : {}),
      followedUpAt: now,
      followedUpByEmail: actor?.email ?? null,
    },
  });
  await audit({
    req, actor,
    action: 'STATUS_CHANGE',
    entity: 'TripFeedback', entityId: updated.id,
    before: {
      followUpStatus: before.followUpStatus,
      followUpNote: before.followUpNote,
    },
    after: {
      followUpStatus: updated.followUpStatus,
      followUpNote: updated.followUpNote,
      bookingId: updated.bookingId,
    },
  });
  return updated;
}

export async function ackDetractorFeedback({ req, actor, feedbackId, note = null }) {
  return transitionFollowUp({ req, actor, feedbackId, toStatus: 'ACKED', note, noteRequired: false });
}

export async function resolveDetractorFeedback({ req, actor, feedbackId, note }) {
  return transitionFollowUp({ req, actor, feedbackId, toStatus: 'RESOLVED', note, noteRequired: true });
}

export async function markDetractorUnreachable({ req, actor, feedbackId, note }) {
  return transitionFollowUp({ req, actor, feedbackId, toStatus: 'UNREACHABLE', note, noteRequired: true });
}

/**
 * Queue listing for /admin/nps/detractors. Filters to detractors only
 * (score ≤ DETRACTOR_THRESHOLD). Optional `status` narrows to a single
 * lifecycle state; default returns NEW + ACKED (active queue) so admin
 * doesn't see resolved/unreachable noise.
 *
 * Returns rows with KPI counts so the page can render a strip without
 * a second query.
 */
export async function listDetractorFeedback({
  status = 'OPEN', limit = 100, now = new Date(),
} = {}) {
  // KPI counts: scan ALL detractor rows regardless of `status` filter so
  // the strip is honest about the full queue state.
  const allDetractors = await db.tripFeedback.findMany({
    where: { score: { lte: DETRACTOR_THRESHOLD } },
    select: {
      id: true, followUpStatus: true, submittedAt: true, escalatedAt: true,
    },
  });
  const counts = { total: allDetractors.length, NEW: 0, ACKED: 0, RESOLVED: 0, UNREACHABLE: 0, escalated: 0 };
  for (const r of allDetractors) {
    counts[r.followUpStatus] = (counts[r.followUpStatus] || 0) + 1;
    if (r.escalatedAt) counts.escalated += 1;
  }
  const whereStatus = status === 'OPEN'
    ? { in: ['NEW', 'ACKED'] }
    : status === 'ALL'
      ? undefined
      : { equals: status };
  const where = { score: { lte: DETRACTOR_THRESHOLD } };
  if (whereStatus !== undefined) where.followUpStatus = whereStatus;
  const rows = await db.tripFeedback.findMany({
    where,
    orderBy: [
      // Open rows first (NEW then ACKED), then resolved/unreachable.
      { followUpStatus: 'asc' },
      { submittedAt: 'asc' }, // within bucket, oldest first (urgency)
    ],
    take: Math.max(1, Math.min(500, limit)),
    select: {
      id: true, score: true, comment: true, submittedAt: true,
      followUpStatus: true, followUpNote: true,
      followedUpAt: true, followedUpByEmail: true, escalatedAt: true,
      booking: {
        select: {
          id: true, bookingNo: true,
          jemaah: { select: { fullName: true, phone: true, email: true } },
          agent: { select: { slug: true, displayName: true } },
        },
      },
      paket: { select: { slug: true, title: true } },
    },
  });
  // Attach ageHours so the view can colour rows.
  const enriched = rows.map((r) => ({
    ...r,
    ageHours: Math.round(((now.getTime() - r.submittedAt.getTime()) / 3_600_000) * 10) / 10,
  }));
  return { rows: enriched, counts, status };
}

export {
  bucketFor, MIN_SAMPLE, DETRACTOR_THRESHOLD,
  ALLOWED_TRANSITIONS as DETRACTOR_TRANSITIONS,
};
