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
export async function cancelBooking({ req, actor, bookingId, reason }) {
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan pembatalan wajib diisi (min. 3 karakter)', 'CANCEL_REASON_REQUIRED');
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
      // S145 — surface the no-show context in the audit trail so a
      // later compliance scan can answer "how many no-shows did we
      // formally close out last quarter?".
      ...(before.noShowAt ? { wasNoShow: true, noShowFlaggedAt: before.noShowAt.toISOString() } : {}),
    },
  });

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
