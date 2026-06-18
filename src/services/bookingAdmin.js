import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export async function getBookingById(id) {
  const booking = await db.booking.findUnique({
    where: { id },
    include: {
      paket: { select: { id: true, slug: true, title: true, departureDate: true, returnDate: true } },
      jemaah: {
        include: {
          documents: { orderBy: { type: 'asc' } },
        },
      },
      agent: { select: { id: true, slug: true, displayName: true, whatsapp: true } },
      room: { select: { id: true, roomNo: true, floor: true, wing: true, capacity: true } },
      payments: { orderBy: { createdAt: 'desc' } },
      komisi: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!booking) return null;

  // Audit history for this booking (entity=Booking, entityId=this)
  const history = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, action: true, actorEmail: true, actorRole: true,
      before: true, after: true, ip: true, createdAt: true,
    },
  });

  return { ...booking, history };
}

// Stage 81 — extract @email mentions from free-text notes. The grammar is
// permissive on purpose: `@user@example.com` and inline mentions like
// "...cek dengan @ops@religio.pro segera" both match. Anchored by a leading
// `@` immediately preceded by start-of-string or whitespace so a stray `@`
// in the middle of a sentence ("a@b") never registers as a mention.
const MENTION_RE = /(?:^|\s)@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
function extractMentionEmails(text) {
  if (!text) return [];
  const out = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    out.add(m[1].toLowerCase());
  }
  return Array.from(out);
}

// Stage 88 — :code shortcut expansion. `:ops` in notes resolves to the
// shortcode's user email and rewrites to `@user@religio.pro`. Done at
// save time so the stored text is stable + readable + the S81 mention
// parser stays unchanged. Unknown codes are LEFT AS-IS (admin typo
// shouldn't silently disappear; visible in the saved notes as `:typo`).
//
// Grammar: same leading-boundary rule as @-mentions. Code is [a-z0-9_-]+
// (case-insensitive on input; lowercased before lookup).
const SHORTCODE_RE = /(^|\s):([a-zA-Z0-9_-]+)\b/g;

async function expandShortcodes(text) {
  if (!text || !text.includes(':')) return text;
  // Collect distinct codes first to one batched DB lookup
  const codes = new Set();
  let m;
  SHORTCODE_RE.lastIndex = 0;
  while ((m = SHORTCODE_RE.exec(text)) !== null) {
    codes.add(m[2].toLowerCase());
  }
  if (codes.size === 0) return text;

  const rows = await db.mentionShortcode.findMany({
    where: { code: { in: [...codes] } },
    select: { code: true, user: { select: { email: true, deletedAt: true, status: true } } },
  });
  const lookup = new Map();
  for (const r of rows) {
    if (!r.user || r.user.deletedAt || r.user.status !== 'ACTIVE') continue;
    if (!r.user.email) continue;
    lookup.set(r.code.toLowerCase(), r.user.email);
  }
  if (lookup.size === 0) return text;

  SHORTCODE_RE.lastIndex = 0;
  return text.replace(SHORTCODE_RE, (full, lead, code) => {
    const email = lookup.get(code.toLowerCase());
    return email ? `${lead}@${email}` : full;
  });
}

/**
 * Update a booking's free-text notes. Idempotent; safe to call repeatedly.
 *   - Trims whitespace; empty string is stored as null.
 *   - Caps at 2000 chars (silently truncates above that — caller should
 *     enforce this in the UI as well).
 *   - Skips DB write + audit if the value didn't actually change.
 *   - Stage 81: fires BOOKING_NOTE_MENTION notifs for any @email tokens
 *     that are NEW in `next` vs `before.notes`. Diffing by-email (not
 *     by-token-position) so adding context around an existing mention
 *     doesn't re-fire the notif.
 */
/**
 * Stage 206 — toggle the pinned flag on a booking's notes. When
 * pinned, the note renders as a gold banner at the top of
 * /admin/bookings/:id so urgent context isn't buried.
 *
 * Idempotent: passing the current value returns no-op without
 * audit pollution. Refuses on bookings without notes (no point
 * pinning empty content).
 */
export async function toggleBookingNotesPinned({ req, actor, bookingId, pinned }) {
  const next = !!pinned;
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, notes: true, notesPinned: true },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (next && (!before.notes || before.notes.trim() === '')) {
    throw new HttpError(409, 'Tidak ada catatan untuk di-pin', 'EMPTY_NOTES');
  }
  if (before.notesPinned === next) {
    return { updated: false, booking: before };
  }
  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { notesPinned: next },
    select: { id: true, notesPinned: true },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { notesPinned: before.notesPinned },
    after: { notesPinned: next, field: 'notesPinned' },
  });
  return { updated: true, booking: updated };
}

export async function updateBookingNotes({ req, actor, bookingId, notes }) {
  // Stage 88 — expand :code shortcuts → @user.email BEFORE trim/cap
  // so length checks see the final stored text, not the abbreviated form.
  const expanded = await expandShortcodes(notes ?? '');
  const cleaned = expanded.toString().trim().slice(0, 2000);
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, notes: true },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');

  const next = cleaned === '' ? null : cleaned;
  if ((before.notes ?? null) === next) {
    return before; // no-op — don't pollute audit log
  }

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { notes: next },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { notes: before.notes },
    after: { notes: next, field: 'notes' },
  });

  // Stage 81 — fire @-mention notifs for newly-introduced mentions only.
  // Non-blocking: failure to enqueue must never undo the notes write.
  const beforeMentions = new Set(extractMentionEmails(before.notes));
  const afterMentions = extractMentionEmails(next);
  const newMentions = afterMentions.filter((e) => !beforeMentions.has(e));
  if (newMentions.length > 0) {
    try {
      const fullBooking = await db.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true, bookingNo: true, notes: true,
          jemaah: { select: { fullName: true } },
          paket: { select: { title: true } },
        },
      });
      const { notifyBookingNoteMention } = await import('./notifications.js');
      await notifyBookingNoteMention({ booking: fullBooking, mentions: newMentions, actor });
    } catch (err) {
      console.warn('[booking-mention] enqueue failed:', err?.message || err);
    }
  }

  // Stage 91 — extract `@email TODO ...` follow-ups into Task rows.
  // Non-blocking same as mention fan-out; idempotent on (booking, email,
  // body) so re-saving the same notes is a no-op.
  try {
    const { upsertTodosForBooking } = await import('./tasks.js');
    await upsertTodosForBooking({ bookingId, notes: next, actor });
  } catch (err) {
    console.warn('[task] upsert failed:', err?.message || err);
  }

  // Stage 127 — outbound `booking.notes_updated` webhook. Best-effort.
  // Skipped when `next` equals the prior value (the early-return above
  // means we don't even reach this line on no-ops).
  try {
    const { dispatchEvent } = await import('./webhooks.js');
    await dispatchEvent('booking.notes_updated', {
      bookingId,
      bookingNo: updated.bookingNo,
      paketId: updated.paketId,
      notesPreview: (next || '').slice(0, 400),
      actorEmail: actor?.email || null,
    });
  } catch (err) {
    console.warn('[bookingAdmin] booking.notes_updated dispatch failed:', err?.message || err);
  }

  return updated;
}

// Exported for tests + future surfaces that want to preview mentions
// before save (e.g. inline highlight in the textarea).
export { extractMentionEmails };

/**
 * Transfer a booking from one agent to another (or to Kantor Pusat / no agent).
 *
 * Invariants:
 *   - `agentSlugCap` is NEVER touched — that's the historical URL trail, which
 *     stays put as audit evidence of where the visitor originally came from.
 *   - Booking must be active (not CANCELLED/REFUNDED).
 *   - If toAgentId equals current agentId, no-op (returns booking unchanged).
 *   - Komisi handling per status:
 *       PENDING   → re-point to toAgent (if not null) or DELETE (Kantor Pusat doesn't get komisi)
 *       EARNED    → opt-in via `includeEarnedKomisi` flag (default: stay with original agent
 *                   because they earned it; admin can transfer if appropriate)
 *       PAID      → never touch (already disbursed)
 *       CANCELLED → never touch (history)
 *
 * Audit summary includes: from/to agent id+slug, reason, komisi action counts.
 */
export async function transferBookingAgent({ req, actor, bookingId, toAgentId, reason, includeEarnedKomisi = false }) {
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan transfer wajib diisi (min. 3 karakter)', 'TRANSFER_REASON_REQUIRED');
  }

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNo: true, status: true, agentId: true, agentSlugCap: true,
      komisi: { select: { id: true, status: true } },
      agent: { select: { slug: true, displayName: true } },
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded — tidak bisa transfer', 'BOOKING_CLOSED');
  }
  const normalizedTo = toAgentId || null;
  if (normalizedTo === booking.agentId) {
    return { booking, noop: true };
  }

  let toAgent = null;
  if (normalizedTo) {
    toAgent = await db.agentProfile.findUnique({
      where: { id: normalizedTo },
      select: { id: true, slug: true, displayName: true },
    });
    if (!toAgent) throw new HttpError(404, 'Agen tujuan tidak ditemukan', 'AGENT_NOT_FOUND');
  }

  // Classify komisi
  const pending = booking.komisi.filter((k) => k.status === 'PENDING');
  const earned = booking.komisi.filter((k) => k.status === 'EARNED');
  const pendingIds = pending.map((k) => k.id);
  const earnedIds = earned.map((k) => k.id);

  let pendingMoved = 0, pendingDeleted = 0, earnedMoved = 0;

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.booking.update({
      where: { id: bookingId },
      data: { agentId: normalizedTo },
    });

    // PENDING komisi: move or delete
    if (pendingIds.length > 0) {
      if (normalizedTo) {
        const r = await tx.komisi.updateMany({
          where: { id: { in: pendingIds } },
          data: { agentId: normalizedTo },
        });
        pendingMoved = r.count;
      } else {
        const r = await tx.komisi.deleteMany({ where: { id: { in: pendingIds } } });
        pendingDeleted = r.count;
      }
    }

    // EARNED komisi: opt-in transfer (otherwise stays with original agent)
    if (includeEarnedKomisi && earnedIds.length > 0 && normalizedTo) {
      const r = await tx.komisi.updateMany({
        where: { id: { in: earnedIds } },
        data: { agentId: normalizedTo },
      });
      earnedMoved = r.count;
    }

    return u;
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: {
      agentId: booking.agentId,
      agentSlug: booking.agent?.slug ?? null,
    },
    after: {
      agentId: normalizedTo,
      agentSlug: toAgent?.slug ?? null,
      agentDisplayName: toAgent?.displayName ?? '— Kantor Pusat —',
      agentSlugCap: booking.agentSlugCap, // unchanged — emphasised in audit
      transfer: true,
      reason: reason.trim(),
      komisi: {
        pendingMoved, pendingDeleted, earnedMoved,
        earnedKept: earned.length - earnedMoved,
      },
    },
  });

  return { booking: updated, noop: false, fromAgent: booking.agent, toAgent };
}

/**
 * Cancel a booking.
 *   - Refuses if already CANCELLED/REFUNDED
 *   - Sets status=CANCELLED + cancelledAt + cancelReason
 *   - Decrements Paket.kursiTerisi by paxCount (frees the seat back)
 *   - Unassigns from room (roomId=null)
 *   - Cancels any EARNED komisi (status=CANCELLED) — leaves PAID alone (already disbursed)
 *   - Audit row
 *
 * Note: Payment rows are NOT touched. Refund is a separate flow (5k.x).
 */
const CANCEL_REASON_CODES = new Set([
  'JEMAAH_REQUEST', 'PAKET_CANCELLED', 'PAYMENT_NOT_RECEIVED',
  'DOCUMENT_INCOMPLETE', 'NO_SHOW', 'GOODWILL', 'OTHER',
]);
export { CANCEL_REASON_CODES };

export async function cancelBooking({ req, actor, bookingId, reason, reasonCode = null }) {
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan pembatalan wajib diisi (min. 3 karakter)', 'CANCEL_REASON_REQUIRED');
  }
  // Stage 175 — structured category. Optional input (null when admin
  // declined to pick); validated against the enum so a typo doesn't
  // hit the DB as a 500.
  let cancelReasonCode = null;
  if (reasonCode != null && reasonCode !== '') {
    const code = String(reasonCode).trim().toUpperCase();
    if (!CANCEL_REASON_CODES.has(code)) {
      throw new HttpError(400, `Reason code tidak valid: ${reasonCode}`, 'BAD_CANCEL_REASON_CODE');
    }
    cancelReasonCode = code;
  }
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNo: true, status: true, paxCount: true,
      // S136 — kelas needed for the auto-promote shape (we re-allocate
      // the freed seat in the same kelas the cancel just vacated).
      kelas: true,
      paketId: true, roomId: true, agentId: true,
      paidAmount: true, totalAmount: true,
      // S145 — no-show stamp so the cancel audit trail records
      // "this was a no-show being closed out".
      noShowAt: true,
      // S301 — agent contact for the agent-cancel notif (best-effort).
      agent: {
        select: {
          id: true, slug: true, displayName: true, whatsapp: true,
          user: { select: { id: true, email: true } },
        },
      },
      // S301 — jemaah name for the agent notif body.
      jemaah: { select: { fullName: true } },
    },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (before.status === 'CANCELLED' || before.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'ALREADY_CLOSED');
  }

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason.trim(),
        cancelReasonCode,
        roomId: null,
        // Clear any pending jemaah request now that admin acted (5ff)
        cancelRequested: false,
        cancelRequestedAt: null,
        cancelRequestReason: null,
      },
    });
    // Free seats back to pool
    await tx.paket.update({
      where: { id: before.paketId },
      data: { kursiTerisi: { decrement: before.paxCount } },
    });
    // Cancel EARNED komisi (PAID is already disbursed — keep history)
    await tx.komisi.updateMany({
      where: { bookingId, status: 'EARNED' },
      data: { status: 'CANCELLED' },
    });
    return u;
  });

  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'Booking', entityId: bookingId,
    before: { status: before.status, roomId: before.roomId, paidAmount: Number(before.paidAmount) },
    after: {
      status: 'CANCELLED', cancelReason: reason.trim(), kursiFreed: before.paxCount,
      ...(cancelReasonCode ? { cancelReasonCode } : {}),
      // S145 — surface the no-show context in the audit trail so a
      // later compliance scan can answer "how many no-shows did we
      // formally close out last quarter?".
      ...(before.noShowAt ? { wasNoShow: true, noShowFlaggedAt: before.noShowAt.toISOString() } : {}),
    },
  });

  // Stage 301 — when the cancelled booking has an agent, notify them
  // so they don't keep follow-up on dead booking. Walk-in bookings
  // (agentId null) skip silently. Best-effort — failure logs but
  // never aborts the cancel.
  if (before.agent) {
    try {
      const { notifyBookingCancelledAgent } = await import('./notifications.js');
      await notifyBookingCancelledAgent({
        booking: { id: before.id, bookingNo: before.bookingNo, jemaah: before.jemaah },
        agent: {
          id: before.agent.id, slug: before.agent.slug,
          displayName: before.agent.displayName,
          whatsapp: before.agent.whatsapp,
          userId: before.agent.user?.id || null,
          userEmail: before.agent.user?.email || null,
        },
        reason: reason.trim(),
        adminEmail: actor?.email,
      });
    } catch (err) {
      console.warn('[bookingAdmin] notifyBookingCancelledAgent failed:', err?.message || err);
    }
  }

  // Stage 42/136 — cancel just freed `paxCount` seats. If a WAITING
  // jemaah on the waitlist is "verified" (existing JEMAAH account with
  // ≥1 prior LUNAS), auto-promote them directly (S136). Otherwise fall
  // back to the S42 nudge so admin can manually promote.
  //
  // Auto-promote uses the freed booking's kelas + paxCount as defaults
  // — we just made room for exactly that shape. If the jemaah wanted
  // a different kelas they're free to refuse (manual admin override
  // via existing cancel+re-promote flow).
  //
  // Fire-and-forget — neither path may abort the cancel.
  let autoPromoted = null;
  try {
    const { findVerifiedWaitlistForPaket, promoteWaitlist } = await import('./waitlist.js');
    const verified = await findVerifiedWaitlistForPaket({ paketId: before.paketId });
    if (verified) {
      // System-style auto-promote — actor is the admin who cancelled,
      // with a flag in the audit row so the action is attributable
      // but distinguishable from a hand-clicked promote.
      const promoted = await promoteWaitlist({
        req, actor,
        id: verified.waitlist.id,
        kelas: before.kelas,
        paxCount: before.paxCount,
      });
      autoPromoted = {
        waitlistId: verified.waitlist.id,
        bookingNo: promoted.booking.bookingNo,
        userEmail: verified.user.email,
        priorLunasCount: verified.priorLunasCount,
      };
      // Decorate the promote audit row with the auto-promote signal.
      await audit({
        req, actor,
        action: 'UPDATE', entity: 'PaketWaitlist', entityId: verified.waitlist.id,
        after: {
          autoPromoted: true,
          trigger: 'cancel.auto_promote',
          sourceBookingNo: before.bookingNo,
          verifiedSignal: { userEmail: verified.user.email, priorLunasCount: verified.priorLunasCount },
        },
      });
    }
  } catch (err) {
    console.warn('[bookingAdmin] auto-promote failed:', err?.message || err);
  }

  // Skip the nudge when auto-promote succeeded — admin doesn't need the
  // "freed seats, here are candidates" email if we already handled it.
  if (!autoPromoted) {
    try {
      const { notifyWaitlistSlotFreed } = await import('./notifications.js');
      await notifyWaitlistSlotFreed({
        paketId: before.paketId,
        freedSeats: before.paxCount,
        sourceBookingNo: before.bookingNo,
      });
    } catch (err) {
      console.warn('[bookingAdmin] notifyWaitlistSlotFreed failed:', err?.message || err);
    }
  }

  // Stage 108/127 — outbound webhooks. `booking.cancelled` (legacy event)
  // + `booking.status_changed` (S127 — generic state change for partners
  // who track lifecycle, not just specific transitions). Best-effort.
  try {
    const { dispatchEvent } = await import('./webhooks.js');
    const payload = {
      bookingId, bookingNo: updated.bookingNo,
      previousStatus: before.status, status: 'CANCELLED',
      paketId: before.paketId,
      reason: reason.trim(),
      kursiFreed: before.paxCount,
    };
    await dispatchEvent('booking.cancelled', payload);
    await dispatchEvent('booking.status_changed', payload);
  } catch (err) {
    console.warn('[bookingAdmin] webhook dispatch failed:', err?.message || err);
  }

  return updated;
}

/**
 * Stage 226 — recommended built-in tags. Admin can add free-form ones
 * too; this list just drives the dropdown chips on /admin/bookings/:id.
 */
export const BOOKING_TAG_PRESETS = [
  'VIP', 'LANSIA', 'HONEYMOON', 'KELUARGA', 'KESEHATAN',
  'PERTAMA', 'DIFABEL', 'PRIORITAS',
];

/**
 * Normalise + dedupe a tag input. Drops empty strings, trims, uppercases,
 * caps each at 24 chars, caps the array at 8 entries (defensive against
 * tag bloat). Anything non-string filtered out.
 */
export function normaliseBookingTags(raw) {
  if (raw == null) return [];
  let arr = raw;
  if (typeof raw === 'string') arr = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(arr)) return [];
  const cleaned = arr
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim().toUpperCase().slice(0, 24))
    .filter((t) => /^[A-Z0-9_-]+$/.test(t) && t.length > 0);
  return [...new Set(cleaned)].slice(0, 8);
}

/**
 * Stage 226 — set the tag list on a booking. Empty array → clears to
 * NULL in DB (back-compat read path stays simple). Idempotent re-save
 * with identical list is a no-op (no audit pollution).
 *
 * Refuses on CANCELLED/REFUNDED (tags are an active-booking concern;
 * once cancelled they're frozen history).
 */
export async function setBookingTags({ req, actor, bookingId, tags }) {
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, bookingNo: true, status: true, tags: true },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (before.status === 'CANCELLED' || before.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'BOOKING_CLOSED');
  }
  const normalised = normaliseBookingTags(tags);
  const dbValue = normalised.length === 0 ? null : normalised;

  const beforeArr = Array.isArray(before.tags) ? before.tags : [];
  const same = beforeArr.length === normalised.length
    && beforeArr.every((t, i) => t === normalised[i]);
  if (same) return { updated: false, tags: normalised };

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { tags: dbValue },
    select: { id: true, tags: true },
  });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { tags: beforeArr },
    after: { tags: normalised, tagsChanged: true },
  });
  return { updated: true, tags: updated.tags || [] };
}

/**
 * Stage 224 — admin explicitly declines a jemaah's cancel request without
 * cancelling the booking. Clears the three S5ff `cancelRequest*` fields
 * so the booking returns to its prior state + leaves an audit trail
 * citing the admin's reason.
 *
 * Why this exists: before S224 the only outcomes for a cancel-request
 * banner were "approve via cancelBooking" or "leave hanging". Hanging
 * requests confused the jemaah (their /saya kept showing "pending") and
 * polluted the needs-attention surface. Decline closes the loop.
 *
 * Refuses on:
 *   - booking already CANCELLED/REFUNDED (request flag is moot)
 *   - no pending request (nothing to decline)
 *   - reason missing (3-char minimum — admin must justify)
 *
 * Best-effort notif to jemaah via `notifyCancelRequestDeclined` so they
 * see the decline in `/saya/notifications`. Notif failure is logged but
 * doesn't abort the decline (the audit row is the load-bearing record).
 */
export async function declineCancelRequest({ req, actor, bookingId, reason }) {
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan tolak request wajib (min. 3 karakter)', 'DECLINE_REASON_REQUIRED');
  }
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNo: true, status: true,
      cancelRequested: true, cancelRequestedAt: true, cancelRequestReason: true,
      jemaahUserId: true, jemaahId: true,
      jemaah: { select: { fullName: true, email: true, phone: true, notifEmail: true, notifWa: true } },
    },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (before.status === 'CANCELLED' || before.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'ALREADY_CLOSED');
  }
  if (!before.cancelRequested) {
    throw new HttpError(409, 'Tidak ada permintaan pembatalan yang menunggu', 'NO_PENDING_REQUEST');
  }

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: {
      cancelRequested: false,
      cancelRequestedAt: null,
      cancelRequestReason: null,
    },
    select: { id: true, bookingNo: true, status: true },
  });

  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'Booking', entityId: bookingId,
    before: {
      cancelRequested: true,
      cancelRequestReason: before.cancelRequestReason,
    },
    after: {
      cancelRequested: false,
      cancelRequestDeclined: true,
      declineReason: reason.trim(),
      declinedBy: actor.email,
    },
  });

  // Notify jemaah — best-effort, never abort the decline
  try {
    const { notifyCancelRequestDeclined } = await import('./notifications.js');
    await notifyCancelRequestDeclined({
      booking: {
        id: before.id, bookingNo: before.bookingNo,
        jemaahUserId: before.jemaahUserId,
        jemaah: before.jemaah,
      },
      declineReason: reason.trim(),
      adminEmail: actor.email,
    });
  } catch (err) {
    console.warn('[declineCancelRequest] notif failed:', err?.message || err);
  }

  return updated;
}

// ── Stage 337 — booking reschedule ───────────────────────────────
//
// Move a jemaah from one paket to another, preserving paidAmount,
// agent attribution, notes, and jemaah identity. The source booking
// goes terminal (status=RESCHEDULED) with rescheduledToBookingId
// pointing at the new booking. The new booking starts at a status
// matching the carried paidAmount (PENDING / DP_PAID / PARTIAL / LUNAS).
//
// Distinct from:
//   - cancelBooking + new booking — loses payment history + komisi
//   - cloneBooking (S256) — creates a NEW booking for a DIFFERENT jemaah
//   - transferBookingAgent (S5q) — changes agent, same paket
//   - handoverBookingJemaah (S280) — changes jemaah, same paket
//
// Same booking row stays around (status=RESCHEDULED) so the audit
// timeline + analytics retain the original entry.
// Stage 344 — allowed reschedule reason codes. Service-side allowlist
// matches the Prisma enum; case-insensitive normalisation on input.
export const RESCHEDULE_REASON_CODES = new Set([
  'JEMAAH_REQUEST', 'DOCUMENT_DELAY', 'HEALTH', 'FINANCIAL',
  'PAKET_FULL', 'SCHEDULE_CONFLICT', 'OPERATOR_INITIATED', 'OTHER',
]);

export async function rescheduleBooking({
  req, actor, sourceBookingId, targetPaketId, targetKelas,
  targetPaxCount = null, reason = null, reasonCode = null,
}) {
  if (!sourceBookingId) throw new HttpError(400, 'sourceBookingId required', 'BAD_INPUT');
  if (!targetPaketId) throw new HttpError(400, 'targetPaketId required', 'BAD_INPUT');
  if (!targetKelas) throw new HttpError(400, 'targetKelas required', 'BAD_INPUT');

  // Stage 344 — validate optional reasonCode against the enum.
  let normReasonCode = null;
  if (reasonCode != null && reasonCode !== '') {
    const code = String(reasonCode).trim().toUpperCase();
    if (!RESCHEDULE_REASON_CODES.has(code)) {
      throw new HttpError(400, `Reschedule reason code tidak valid: ${reasonCode}`, 'BAD_RESCHEDULE_REASON_CODE');
    }
    normReasonCode = code;
  }

  const source = await db.booking.findUnique({
    where: { id: sourceBookingId },
    select: {
      id: true, bookingNo: true, status: true, paxCount: true, kelas: true,
      paketId: true, jemaahId: true, jemaahUserId: true,
      agentId: true, agentSlugCap: true, currency: true,
      paidAmount: true, totalAmount: true, notes: true,
      paket: { select: { title: true } },
      jemaah: { select: { fullName: true, phone: true, email: true } },
    },
  });
  if (!source) throw new HttpError(404, 'Booking sumber tidak ditemukan', 'BOOKING_NOT_FOUND');
  const TERMINAL = new Set(['CANCELLED', 'REFUNDED', 'RESCHEDULED']);
  if (TERMINAL.has(source.status)) {
    throw new HttpError(409, `Booking sudah ${source.status} — tidak bisa di-reschedule`, 'SOURCE_CLOSED');
  }
  if (source.paketId === targetPaketId) {
    throw new HttpError(409, 'Paket tujuan sama dengan paket sumber', 'SAME_PAKET');
  }

  const target = await db.paket.findUnique({
    where: { id: targetPaketId },
    select: {
      id: true, title: true, slug: true,
      departureDate: true, returnDate: true,
      kursiTotal: true, kursiTerisi: true,
      status: true, deletedAt: true,
      prices: { where: { kelas: targetKelas }, select: { priceIdr: true } },
    },
  });
  if (!target || target.deletedAt || target.status === 'ARCHIVED') {
    throw new HttpError(404, 'Paket tujuan tidak ditemukan / arsip', 'TARGET_PAKET_NOT_FOUND');
  }
  if (!target.prices || target.prices.length === 0) {
    throw new HttpError(409, `Paket tujuan tidak menjual kelas ${targetKelas}`, 'TARGET_KELAS_NOT_OFFERED');
  }

  const newPaxCount = Math.max(1, Math.min(20, Number(targetPaxCount || source.paxCount)));
  const seatsLeft = target.kursiTotal - target.kursiTerisi;
  if (seatsLeft < newPaxCount) {
    throw new HttpError(409, `Kursi tidak cukup di paket tujuan (sisa ${seatsLeft}, butuh ${newPaxCount})`, 'TARGET_FULL');
  }

  const pricePerPax = Number(target.prices[0].priceIdr?.toString?.() ?? target.prices[0].priceIdr) || 0;
  const newTotalAmount = pricePerPax * newPaxCount;
  const carriedPaid = Number(source.paidAmount?.toString?.() ?? source.paidAmount) || 0;

  // New booking number scheme: re-use the public createBooking pattern
  // by generating RP-YYYY-NNNNN. Retry on @unique collision.
  const year = new Date().getFullYear();
  const prefix = `RP-${year}-`;
  let newBookingNo = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await db.booking.count({ where: { bookingNo: { startsWith: prefix } } });
    const candidate = `${prefix}${String(count + 1 + attempt).padStart(5, '0')}`;
    const exists = await db.booking.findUnique({ where: { bookingNo: candidate }, select: { id: true } });
    if (!exists) { newBookingNo = candidate; break; }
  }
  if (!newBookingNo) throw new HttpError(500, 'Gagal alokasi nomor booking baru', 'BOOKING_NO_ALLOC_FAILED');

  // Status of new booking inferred from carried paidAmount vs new total
  let newStatus = 'PENDING';
  if (carriedPaid >= newTotalAmount) newStatus = 'LUNAS';
  else if (carriedPaid > 0) {
    // Mirrors payment.js transitionStatus: DP boundary is "any paid",
    // PARTIAL is "more than DP minimum". We don't know the exact DP
    // threshold here, so use DP_PAID for any partial — admin can adjust
    // via the existing payment-record flow if needed.
    newStatus = 'DP_PAID';
  }

  const noteAppend = `[Rescheduled from ${source.bookingNo} (${source.paket?.title || source.paketId})${reason ? ` — ${reason.slice(0, 200)}` : ''}]`;
  const carriedNotes = source.notes
    ? `${source.notes}\n\n${noteAppend}`
    : noteAppend;

  const now = new Date();
  const { newBooking, updatedSource } = await db.$transaction(async (tx) => {
    // Create the new booking carrying over identity + paid amount.
    const created = await tx.booking.create({
      data: {
        bookingNo: newBookingNo,
        paketId: target.id,
        jemaahId: source.jemaahId, jemaahUserId: source.jemaahUserId,
        agentId: source.agentId, agentSlugCap: source.agentSlugCap,
        kelas: targetKelas, paxCount: newPaxCount,
        totalAmount: String(newTotalAmount), paidAmount: String(carriedPaid),
        currency: source.currency,
        status: newStatus,
        notes: carriedNotes,
      },
    });
    // Source goes terminal with lineage pointer.
    // S340 — clear any pending reschedule request now that admin acted
    // (implicit approval — no separate "approve request" endpoint).
    const updated = await tx.booking.update({
      where: { id: source.id },
      data: {
        status: 'RESCHEDULED',
        rescheduledToBookingId: created.id,
        rescheduledAt: now,
        rescheduledByEmail: actor?.email ?? null,
        // Stage 344 — structured reason category for analytics.
        rescheduleReasonCode: normReasonCode,
        roomId: null, // free room slot — new booking will reassign on target paket
        rescheduleRequested: false,
        rescheduleRequestedAt: null,
        rescheduleRequestReason: null,
        rescheduleRequestTargetPaketId: null,
      },
    });
    // Free source kursi pool, claim target.
    await tx.paket.update({
      where: { id: source.paketId },
      data: { kursiTerisi: { decrement: source.paxCount } },
    });
    await tx.paket.update({
      where: { id: target.id },
      data: { kursiTerisi: { increment: newPaxCount } },
    });
    // Komisi: PENDING re-points to new booking (work that will earn out
    // on the rescheduled trip); EARNED stays on source (agent earned for
    // the original sale work — moving it would erase that history);
    // PAID never touched.
    await tx.komisi.updateMany({
      where: { bookingId: source.id, status: 'PENDING' },
      data: { bookingId: created.id },
    });
    return { newBooking: created, updatedSource: updated };
  });

  // Audit: one row on source (terminal transition) + one on target (creation).
  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'Booking', entityId: source.id,
    before: { status: source.status, paketId: source.paketId, paxCount: source.paxCount },
    after: {
      status: 'RESCHEDULED',
      rescheduledToBookingId: newBooking.id,
      rescheduledToBookingNo: newBooking.bookingNo,
      targetPaketId: target.id, targetKelas, newPaxCount,
      paidCarried: carriedPaid,
      reason: reason ? reason.slice(0, 500) : null,
      ...(normReasonCode ? { rescheduleReasonCode: normReasonCode } : {}),
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'Booking', entityId: newBooking.id,
    after: {
      bookingNo: newBooking.bookingNo,
      paketId: target.id, kelas: targetKelas, paxCount: newPaxCount,
      totalAmount: newTotalAmount, paidAmount: carriedPaid,
      status: newStatus,
      rescheduledFromBookingId: source.id,
      rescheduledFromBookingNo: source.bookingNo,
    },
  });

  // Continue after the transaction with notif fan-out
  // Stage 339 — fire-and-forget notif fan-out (jemaah + agent)
  try {
    const { notifyBookingRescheduled } = await import('./notifications.js');
    await notifyBookingRescheduled({
      sourceBooking: {
        id: source.id, bookingNo: source.bookingNo,
        paketTitle: source.paket?.title,
        jemaah: source.jemaah, jemaahUserId: source.jemaahUserId,
        agentId: source.agentId,
      },
      newBooking: {
        id: newBooking.id, bookingNo: newBooking.bookingNo,
        paketTitle: target.title, paketSlug: target.slug,
        departureDate: target.departureDate, returnDate: target.returnDate,
        totalAmount: newTotalAmount, paidAmount: carriedPaid,
        kelas: targetKelas, paxCount: newPaxCount,
      },
      reason, adminEmail: actor?.email,
    });
  } catch (err) {
    console.warn('[rescheduleBooking] notif failed:', err?.message || err);
  }

  return { source: updatedSource, newBooking };
}

// Stage 343 — admin queue page for pending reschedule requests. Mirrors
// S331 help-requests aggregation pattern. Lists bookings where
// `rescheduleRequested=true` AND status is non-terminal, sorted oldest
// first (most urgent at top). Per-row carries jemaah identity + paket +
// preferred target + age + WhatsApp deep link.
export async function listPendingRescheduleRequests({ limit = 200, now = new Date() } = {}) {
  const bookings = await db.booking.findMany({
    where: {
      rescheduleRequested: true,
      status: { notIn: ['CANCELLED', 'REFUNDED', 'RESCHEDULED'] },
    },
    orderBy: { rescheduleRequestedAt: 'asc' }, // oldest first
    take: Math.max(1, Math.min(500, limit)),
    select: {
      id: true, bookingNo: true,
      rescheduleRequestedAt: true, rescheduleRequestReason: true,
      rescheduleRequestTargetPaketId: true,
      jemaah: { select: { fullName: true, phone: true, email: true } },
      paket: { select: { slug: true, title: true } },
    },
  });

  // Resolve preferred target paket titles in one batched query (avoid N+1)
  const targetIds = [...new Set(bookings.map((b) => b.rescheduleRequestTargetPaketId).filter(Boolean))];
  let targetMap = new Map();
  if (targetIds.length > 0) {
    const targets = await db.paket.findMany({
      where: { id: { in: targetIds } },
      select: { id: true, slug: true, title: true, departureDate: true },
    });
    targetMap = new Map(targets.map((t) => [t.id, t]));
  }

  const rows = bookings.map((b) => ({
    bookingId: b.id,
    bookingNo: b.bookingNo,
    jemaah: b.jemaah,
    paket: b.paket,
    requestedAt: b.rescheduleRequestedAt,
    reason: b.rescheduleRequestReason,
    targetPaket: b.rescheduleRequestTargetPaketId
      ? (targetMap.get(b.rescheduleRequestTargetPaketId) || null)
      : null,
    ageHours: b.rescheduleRequestedAt
      ? Math.round(((now.getTime() - b.rescheduleRequestedAt.getTime()) / 3_600_000) * 10) / 10
      : null,
  }));

  return {
    rows,
    counts: {
      pending: rows.length,
      withTarget: rows.filter((r) => !!r.targetPaket).length,
      noTarget: rows.filter((r) => !r.targetPaket).length,
    },
  };
}

// Stage 341 — admin declines a pending S340 reschedule request without
// actually rescheduling. Clears the 4 request fields + writes audit row
// + fires GENERIC notif to jemaah explaining. Mirrors declineCancelRequest
// pattern.
export async function declineRescheduleRequest({ req, actor, bookingId, reason }) {
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan tolak request wajib (min. 3 karakter)', 'DECLINE_REASON_REQUIRED');
  }
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNo: true, status: true,
      rescheduleRequested: true, rescheduleRequestedAt: true,
      rescheduleRequestReason: true, rescheduleRequestTargetPaketId: true,
      jemaahUserId: true, jemaahId: true,
      jemaah: { select: { fullName: true, email: true, phone: true } },
    },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  const TERMINAL = new Set(['CANCELLED', 'REFUNDED', 'RESCHEDULED']);
  if (TERMINAL.has(before.status)) {
    throw new HttpError(409, `Booking sudah ${before.status}`, 'ALREADY_CLOSED');
  }
  if (!before.rescheduleRequested) {
    throw new HttpError(409, 'Tidak ada permintaan reschedule yang menunggu', 'NO_PENDING_REQUEST');
  }

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: {
      rescheduleRequested: false,
      rescheduleRequestedAt: null,
      rescheduleRequestReason: null,
      rescheduleRequestTargetPaketId: null,
    },
    select: { id: true, bookingNo: true, status: true },
  });

  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'Booking', entityId: bookingId,
    before: {
      rescheduleRequested: true,
      rescheduleRequestReason: before.rescheduleRequestReason,
    },
    after: {
      rescheduleRequested: false,
      rescheduleRequestDeclined: true,
      declineReason: reason.trim(),
      declinedBy: actor.email,
    },
  });

  // Notify jemaah — best-effort, never abort the decline
  try {
    const { notifyRescheduleRequestDeclined } = await import('./notifications.js');
    await notifyRescheduleRequestDeclined({
      booking: {
        id: before.id, bookingNo: before.bookingNo,
        jemaahUserId: before.jemaahUserId,
        jemaah: before.jemaah,
      },
      declineReason: reason.trim(),
      adminEmail: actor.email,
    });
  } catch (err) {
    console.warn('[declineRescheduleRequest] notif failed:', err?.message || err);
  }

  return updated;
}
