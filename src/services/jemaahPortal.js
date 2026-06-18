import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { JemaahSchema, updateJemaah } from './jemaahAdmin.js';
import { DOC_TYPES } from './jemaahDocs.js';
import { notifyCancelRequested } from './notifications.js';

const normalizePhone = (s) => String(s).replace(/[\s\-()]/g, '');

export const ClaimSchema = z.object({
  bookingNo: z.string().min(1).max(50),
  phone: z.string().min(8).max(30),
});

/**
 * Personal dashboard for a logged-in JEMAAH user.
 *   - profile: the JemaahProfile linked via JemaahProfile.userId (1:1; may be null
 *     if the account was just registered without a booking yet).
 *   - bookings: every Booking where jemaahUserId = this user (claimed bookings).
 *     Includes paket + payments-summary for quick at-a-glance display.
 */
export async function getMyDashboard(userId) {
  const [profile, bookings] = await Promise.all([
    db.jemaahProfile.findFirst({
      where: { userId },
      include: {
        documents: { orderBy: { type: 'asc' } },
      },
    }),
    db.booking.findMany({
      where: { jemaahUserId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        paket: { select: { slug: true, title: true, departureDate: true, returnDate: true } },
        jemaah: { select: { fullName: true, phone: true } },
        agent: { select: { displayName: true, slug: true } },
      },
    }),
  ]);
  return { profile, bookings };
}

/**
 * Stage 320 — "Hari Ini" in-trip context. Returns a single object when
 * the jemaah has a LUNAS booking whose paket window (departureDate to
 * returnDate inclusive) covers today. Returns null otherwise so the
 * caller can hide the hero cleanly (no empty-state waste).
 *
 * Day-number math is local-TZ floor so the trip-day boundary lands at
 * midnight wall-clock, not UTC.
 */
export async function getInTripContext(userId, now = new Date()) {
  if (!userId) return null;
  // Cheap scan via the existing index on jemaahUserId; usually 1-3 LUNAS
  // bookings per jemaah lifetime, the JS filter is fine.
  const candidates = await db.booking.findMany({
    where: { jemaahUserId: userId, status: 'LUNAS' },
    select: {
      id: true, bookingNo: true,
      paket: {
        select: {
          id: true, slug: true, title: true,
          departureDate: true, returnDate: true, durationDays: true,
          days: {
            orderBy: { dayNumber: 'asc' },
            select: { dayNumber: true, title: true, description: true },
          },
        },
      },
    },
  });
  if (candidates.length === 0) return null;

  const localMidnight = (d) => {
    const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
  };
  const today = localMidnight(now).getTime();
  for (const b of candidates) {
    const p = b.paket;
    if (!p || !p.departureDate || !p.returnDate) continue;
    const dep = localMidnight(p.departureDate).getTime();
    const ret = localMidnight(p.returnDate).getTime();
    if (today < dep || today > ret) continue;
    // Compute trip day: depDate is Day 1.
    const dayN = Math.floor((today - dep) / 86_400_000) + 1;
    const total = Math.max(p.durationDays || 0, p.days.length);
    const todayItinerary = p.days.find((d) => d.dayNumber === dayN) || null;
    const nextItinerary = p.days.find((d) => d.dayNumber === dayN + 1) || null;
    return {
      booking: { id: b.id, bookingNo: b.bookingNo },
      paket: { slug: p.slug, title: p.title, departureDate: p.departureDate, returnDate: p.returnDate },
      dayN, total,
      todayItinerary, nextItinerary,
    };
  }
  return null;
}

/**
 * Soft-merge the source JemaahProfile into the target:
 *   - Fills missing fields on target from source (target's data wins on conflict)
 *   - Re-points all JemaahDocument rows from source → target, skipping types the
 *     target already has (target's docs win)
 *   - Returns { fieldsCopied, docsTransferred, sourceDeletable }
 *
 * Does NOT touch Booking.jemaahId — caller already re-pointed the relevant booking.
 * Does NOT delete the source profile here (caller decides based on remaining
 * bookings — see claimBooking).
 */
async function mergeProfileInto(tx, targetId, sourceId, { sourceWillBeDeleted = false } = {}) {
  if (targetId === sourceId) return { fieldsCopied: [], docsTransferred: 0 };

  const [target, source] = await Promise.all([
    tx.jemaahProfile.findUnique({ where: { id: targetId } }),
    tx.jemaahProfile.findUnique({
      where: { id: sourceId },
      include: { documents: true },
    }),
  ]);
  if (!target || !source) return { fieldsCopied: [], docsTransferred: 0 };

  const MERGEABLE = ['nik', 'passportNo', 'passportExpiry', 'birthDate', 'gender', 'address', 'emergencyContact', 'notes'];
  const UNIQUE_FIELDS = new Set(['nik', 'passportNo']);
  const patch = {};
  const fieldsCopied = [];
  // Track @unique values we need to free on source first so the patch on
  // target doesn't trip the DB-level @unique constraint.
  const sourceUniqueNullOuts = {};

  for (const f of MERGEABLE) {
    if ((target[f] == null || target[f] === '') && source[f] != null && source[f] !== '') {
      if (UNIQUE_FIELDS.has(f)) {
        // Defensive: don't copy if a THIRD profile (not target, not source)
        // already owns this value — that's a real collision worth refusing.
        const clash = await tx.jemaahProfile.findFirst({
          where: { [f]: source[f], id: { notIn: [targetId, sourceId] } },
        });
        if (clash) continue;
        // If source is about to be deleted anyway, transfer the value: NULL
        // source's copy first (frees the @unique), then queue the patch.
        // If source survives (still has other bookings referencing it), we
        // can't take its @unique away — skip the copy, value stays on source.
        if (!sourceWillBeDeleted) continue;
        sourceUniqueNullOuts[f] = null;
      }
      patch[f] = source[f];
      fieldsCopied.push(f);
    }
  }

  // Free @unique on source BEFORE patching target (otherwise constraint trips).
  if (Object.keys(sourceUniqueNullOuts).length > 0) {
    await tx.jemaahProfile.update({ where: { id: sourceId }, data: sourceUniqueNullOuts });
  }
  if (Object.keys(patch).length > 0) {
    await tx.jemaahProfile.update({ where: { id: targetId }, data: patch });
  }

  // Transfer docs: target wins on type collision (source dup gets deleted)
  const targetTypes = new Set(
    (await tx.jemaahDocument.findMany({ where: { jemaahId: targetId }, select: { type: true } }))
      .map((d) => d.type),
  );
  let docsTransferred = 0;
  for (const doc of source.documents) {
    if (targetTypes.has(doc.type)) {
      await tx.jemaahDocument.delete({ where: { id: doc.id } });
    } else {
      await tx.jemaahDocument.update({ where: { id: doc.id }, data: { jemaahId: targetId } });
      docsTransferred += 1;
    }
  }

  return { fieldsCopied, docsTransferred };
}

/**
 * Claim an anonymous booking by matching (bookingNo, phone) and linking it to
 * this user account.
 *
 * Two-phase write inside one transaction:
 *   1. Set `Booking.jemaahUserId = userId`
 *   2. If the user has their own JemaahProfile (created at register-time), soft-merge:
 *      re-point `Booking.jemaahId` → user's profile, copy missing fields, transfer
 *      docs, delete the now-orphan booking-profile IF no other booking references it.
 *
 * Match rules:
 *   - bookingNo exact
 *   - phone compared after stripping spaces/dashes/parens
 *   - booking must not already be claimed by ANOTHER user (idempotent if same user)
 *
 * Generic 404 on mismatch — never reveal whether the booking exists.
 */
export async function claimBooking({ req, actor, userId, bookingNo, phone }) {
  const booking = await db.booking.findUnique({
    where: { bookingNo },
    include: { jemaah: { select: { id: true, phone: true, fullName: true } } },
  });

  const fail = () => { throw new HttpError(404, 'Booking tidak ditemukan atau telepon tidak cocok', 'CLAIM_MISMATCH'); };
  if (!booking) return fail();
  if (normalizePhone(booking.jemaah.phone) !== normalizePhone(phone)) return fail();

  if (booking.jemaahUserId === userId) {
    return { booking, alreadyClaimed: true };
  }
  if (booking.jemaahUserId && booking.jemaahUserId !== userId) {
    throw new HttpError(409, 'Booking ini sudah ter-claim oleh akun lain', 'CLAIM_TAKEN');
  }

  // Find user's own profile (the one created at register-time)
  const userProfile = await db.jemaahProfile.findFirst({ where: { userId } });

  const { updated, mergeInfo, oldProfileDeleted } = await db.$transaction(async (tx) => {
    // Phase 1: claim
    let updated = await tx.booking.update({
      where: { id: booking.id },
      data: { jemaahUserId: userId },
    });

    let mergeInfo = null;
    let oldProfileDeleted = false;

    // Phase 2: dedup — only if user has own profile AND booking points elsewhere.
    // Order is load-bearing: re-point booking FIRST, then count remaining, then
    // call merge with `sourceWillBeDeleted` so it can safely transfer @unique
    // fields (nik/passportNo) by nulling them on source before patching target.
    if (userProfile && booking.jemaah.id !== userProfile.id) {
      updated = await tx.booking.update({
        where: { id: booking.id },
        data: { jemaahId: userProfile.id },
      });

      const remaining = await tx.booking.count({ where: { jemaahId: booking.jemaah.id } });
      const sourceWillBeDeleted = remaining === 0;

      mergeInfo = await mergeProfileInto(tx, userProfile.id, booking.jemaah.id, { sourceWillBeDeleted });

      if (sourceWillBeDeleted) {
        await tx.jemaahProfile.delete({ where: { id: booking.jemaah.id } });
        oldProfileDeleted = true;
      }
    }

    return { updated, mergeInfo, oldProfileDeleted };
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: booking.id,
    before: { jemaahUserId: null, jemaahId: booking.jemaah.id },
    after: {
      jemaahUserId: userId, bookingNo, claimedBy: actor.email, claim: true,
      ...(mergeInfo ? {
        merged: true,
        targetJemaahId: userProfile.id,
        fieldsCopied: mergeInfo.fieldsCopied,
        docsTransferred: mergeInfo.docsTransferred,
        oldProfileDeleted,
      } : {}),
    },
  });

  return { booking: updated, alreadyClaimed: false, merged: !!mergeInfo, mergeInfo };
}

async function loadOwnProfile(userId) {
  const profile = await db.jemaahProfile.findFirst({ where: { userId } });
  if (!profile) {
    throw new HttpError(404, 'Profil belum dibuat untuk akun ini', 'PROFILE_NOT_FOUND');
  }
  return profile;
}

/**
 * Self-service profile update. Same validation as admin's `updateJemaah`,
 * but scoped to the caller's own profile (no arbitrary jemaahId target).
 */
export async function updateMyProfile({ req, actor, userId, input }) {
  const profile = await loadOwnProfile(userId);
  const validated = JemaahSchema.parse(input);
  // Defer to the admin update — same uniqueness checks, same audit shape.
  // We just override the audit trail to label this as a self-edit.
  const updated = await updateJemaah({
    req,
    actor: actor,
    jemaahId: profile.id,
    input: validated,
  });
  return updated;
}

/**
 * Per-type notif preferences a jemaah is allowed to toggle from /saya/profile.
 * Admin-only notif types (CANCEL_REQUESTED, PAYMENT_SETTLED_ADMIN) are NOT
 * exposed — those go to staff and the jemaah has no agency over them.
 * PAYOUT_CREATED is for agents, not jemaah.
 */
export const JEMAAH_NOTIF_TYPES = [
  'BOOKING_CREATED',
  'PAYMENT_RECEIVED',
  'BOOKING_LUNAS',
  'REFUND_ISSUED',
  'DOC_VERIFIED',
];

/**
 * Bulk-upsert per-type preferences. `prefs` is `{ TYPE: boolean }`. Unknown
 * keys silently ignored (defence against arbitrary inputs from the form).
 * Returns the resulting full state for the jemaah (defaults filled in for
 * missing rows since the model treats absence as "enabled").
 */
export async function setMyNotifTypePrefs({ req, actor, userId, prefs }) {
  const profile = await loadOwnProfile(userId);
  const validEntries = Object.entries(prefs || {})
    .filter(([type]) => JEMAAH_NOTIF_TYPES.includes(type));
  const beforeRows = await db.jemaahNotifPref.findMany({
    where: { jemaahId: profile.id },
    select: { type: true, enabled: true },
  });
  const beforeMap = new Map(beforeRows.map((r) => [r.type, r.enabled]));

  // Upsert each in a transaction so the audit-after snapshot is consistent.
  const changed = [];
  await db.$transaction(async (tx) => {
    for (const [type, raw] of validEntries) {
      const enabled = !!raw;
      const prev = beforeMap.get(type) ?? true;       // default: enabled
      if (prev === enabled) continue;                  // no-op skip
      await tx.jemaahNotifPref.upsert({
        where: { jemaahId_type: { jemaahId: profile.id, type } },
        update: { enabled },
        create: { jemaahId: profile.id, type, enabled },
      });
      changed.push({ type, prev, next: enabled });
    }
  });

  if (changed.length > 0) {
    await audit({
      req, actor,
      action: 'UPDATE', entity: 'JemaahProfile', entityId: profile.id,
      before: { notifTypePrefs: Object.fromEntries(changed.map((c) => [c.type, c.prev])) },
      after: { notifTypePrefs: Object.fromEntries(changed.map((c) => [c.type, c.next])) },
    });
  }

  // Return full state for UI re-render: every JEMAAH_NOTIF_TYPES key with
  // its current value (default true).
  const afterRows = await db.jemaahNotifPref.findMany({
    where: { jemaahId: profile.id },
    select: { type: true, enabled: true },
  });
  const afterMap = new Map(afterRows.map((r) => [r.type, r.enabled]));
  return Object.fromEntries(JEMAAH_NOTIF_TYPES.map((t) => [t, afterMap.get(t) ?? true]));
}

/**
 * Read-only helper for the profile page: returns the current type-pref map
 * with defaults filled in.
 */
export async function getMyNotifTypePrefs(userId) {
  const profile = await loadOwnProfile(userId);
  const rows = await db.jemaahNotifPref.findMany({
    where: { jemaahId: profile.id },
    select: { type: true, enabled: true },
  });
  const map = new Map(rows.map((r) => [r.type, r.enabled]));
  return Object.fromEntries(JEMAAH_NOTIF_TYPES.map((t) => [t, map.get(t) ?? true]));
}

const SelfDocSchema = z.object({
  type: z.enum(DOC_TYPES),
  refNumber: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.string().max(190).optional()),
  expiresAt: z.preprocess(
    (v) => (v === '' || v == null ? null : new Date(String(v))),
    z.date().nullable().optional(),
  ),
  notes: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.string().max(2000).optional()),
});

/**
 * Self-submit a document. Jemaah can never set status to VERIFIED/REJECTED
 * (those are staff-only verdicts) — we infer status from input:
 *   - refNumber filled → SUBMITTED (jemaah claims it's ready for review)
 *   - refNumber empty  → PENDING (jemaah is tracking the slot but hasn't submitted yet)
 * If the doc already exists in a VERIFIED/REJECTED state, jemaah re-submitting
 * resets it to SUBMITTED (re-submission for re-review).
 */
export async function submitMyDoc({ req, actor, userId, input }) {
  const profile = await loadOwnProfile(userId);
  const data = SelfDocSchema.parse(input);
  const status = data.refNumber ? 'SUBMITTED' : 'PENDING';

  const existing = await db.jemaahDocument.findUnique({
    where: { jemaahId_type: { jemaahId: profile.id, type: data.type } },
  });

  const setStamps = (status === 'SUBMITTED' && (!existing || existing.status !== 'SUBMITTED'))
    ? { submittedAt: new Date() }
    : {};

  const doc = await db.jemaahDocument.upsert({
    where: { jemaahId_type: { jemaahId: profile.id, type: data.type } },
    update: {
      status,
      refNumber: data.refNumber ?? null,
      expiresAt: data.expiresAt ?? null,
      notes: data.notes ?? null,
      ...(status !== 'SUBMITTED' ? { /* don't reset submittedAt on PENDING save */ } : setStamps),
      // Clear admin verdict timestamps if re-submitting
      ...(existing && existing.status === 'VERIFIED' ? { verifiedAt: null, verifiedById: null } : {}),
    },
    create: {
      jemaahId: profile.id,
      type: data.type,
      status,
      refNumber: data.refNumber ?? null,
      expiresAt: data.expiresAt ?? null,
      notes: data.notes ?? null,
      ...setStamps,
    },
  });

  await audit({
    req, actor: actor,
    action: existing ? 'UPDATE' : 'CREATE',
    entity: 'JemaahDocument', entityId: doc.id,
    before: existing ? { status: existing.status, refNumber: existing.refNumber } : null,
    after: { jemaahId: profile.id, type: doc.type, status: doc.status, refNumber: doc.refNumber, selfSubmit: true },
  });

  // Stage 249 — notify admin queue when jemaah just submitted something
  // that needs review. Fire-and-forget; the doc write is load-bearing.
  // Skip when status is PENDING (no real submission — jemaah saved a
  // draft without ref number or file).
  if (doc.status === 'SUBMITTED') {
    try {
      const { notifyDocSubmittedAdmin } = await import('./notifications.js');
      await notifyDocSubmittedAdmin({
        jemaah: { id: profile.id, fullName: profile.fullName },
        doc, kind: 'submit',
      });
    } catch (err) {
      console.warn('[submitMyDoc] notif failed:', err?.message || err);
    }
  }

  return doc;
}

/**
 * Jemaah deletes their own doc tracking. Refuses to delete VERIFIED docs
 * (those represent staff sign-off — only staff can remove them).
 */
export async function deleteMyDoc({ req, actor, userId, docId }) {
  const profile = await loadOwnProfile(userId);
  const doc = await db.jemaahDocument.findUnique({ where: { id: docId } });
  if (!doc || doc.jemaahId !== profile.id) {
    throw new HttpError(404, 'Dokumen tidak ditemukan', 'DOC_NOT_FOUND');
  }
  if (doc.status === 'VERIFIED') {
    throw new HttpError(409, 'Dokumen sudah VERIFIED — hubungi admin untuk perubahan', 'DOC_LOCKED');
  }
  await db.jemaahDocument.delete({ where: { id: docId } });
  // 5mm: clean up attached file on disk too
  if (doc.filePath) {
    const { deleteStoredFile } = await import('../lib/docStorage.js');
    const { deleteThumbnail } = await import('../lib/docThumbnail.js');
    await deleteStoredFile(doc.filePath);
    await deleteThumbnail({ jemaahId: doc.jemaahId, docId: doc.id });
  }
  await audit({
    req, actor: actor,
    action: 'DELETE', entity: 'JemaahDocument', entityId: docId,
    before: { jemaahId: profile.id, type: doc.type, status: doc.status, hasFile: !!doc.filePath },
  });
}

/**
 * List ACTIVE paket available to book + flag whether THIS user has an
 * active (non-CANCELLED/REFUNDED) booking on it. Used by /saya/paket browser.
 */
export async function listAvailablePaket(userId) {
  const paket = await db.paket.findMany({
    where: { status: 'ACTIVE', deletedAt: null },
    select: {
      id: true, slug: true, title: true, subtitle: true,
      departureDate: true, returnDate: true, durationDays: true,
      kursiTotal: true, kursiTerisi: true,
      prices: { select: { kelas: true, priceIdr: true, isFeatured: true } },
    },
    orderBy: { departureDate: 'asc' },
  });

  // Single query for the user's bookings, then map per paket. Faster than N
  // separate findMany calls when paket count grows.
  const myBookings = userId
    ? await db.booking.findMany({
        where: { jemaahUserId: userId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        select: { paketId: true, bookingNo: true },
      })
    : [];
  const bookedByPaket = new Map();
  for (const b of myBookings) {
    if (!bookedByPaket.has(b.paketId)) bookedByPaket.set(b.paketId, []);
    bookedByPaket.get(b.paketId).push(b.bookingNo);
  }

  return paket.map((p) => {
    const fillPct = p.kursiTotal === 0 ? 0 : Math.round((p.kursiTerisi / p.kursiTotal) * 100);
    const sortedPrices = [...p.prices].sort((a, b) =>
      Number(a.priceIdr.toString?.() ?? a.priceIdr) - Number(b.priceIdr.toString?.() ?? b.priceIdr),
    );
    const minPrice = sortedPrices[0] ?? null;
    return {
      ...p,
      fillPct,
      slotsLeft: p.kursiTotal - p.kursiTerisi,
      minPrice,
      myBookings: bookedByPaket.get(p.id) || [],
    };
  });
}

/**
 * Jemaah submits a cancel request — admin still has to approve via
 * `cancelBooking`. This sets `Booking.cancelRequested` + reason + timestamp
 * and writes an audit row, but does NOT change `status`.
 *
 * Refuses if:
 *   - booking isn't owned by this user (404 generic — anti-enumeration)
 *   - booking is already CANCELLED or REFUNDED (409 — nothing to request)
 *   - a request is already pending (409 — admin needs to approve/decline existing)
 */
export async function requestCancelByJemaah({ req, actor, userId, bookingId, reason, now = new Date() }) {
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan pembatalan wajib (min. 3 karakter)', 'CANCEL_REASON_REQUIRED');
  }
  const booking = await db.booking.findFirst({
    where: { id: bookingId, jemaahUserId: userId },
    select: {
      id: true, bookingNo: true, status: true, cancelRequested: true,
      // S147 — paket close date drives the jemaah-side deadline lock.
      // Once manifestClosesAt passes, only admin can cancel (the seat
      // can no longer be re-sold; refund mechanics shift to commercial
      // dispute rather than a request flow).
      paket: { select: { manifestClosesAt: true } },
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded', 'ALREADY_CLOSED');
  }
  if (booking.cancelRequested) {
    throw new HttpError(409, 'Permintaan pembatalan sebelumnya masih diproses admin', 'ALREADY_REQUESTED');
  }
  // S147 — deadline lock. Past manifestClosesAt jemaah cannot submit a
  // cancel-request from /saya; they must contact admin directly. The
  // admin flow (cancelBooking) bypasses this guard entirely. Paket
  // without manifestClosesAt (admin chose "never close") never locks.
  if (booking.paket?.manifestClosesAt && booking.paket.manifestClosesAt < now) {
    throw new HttpError(
      409,
      `Deadline pembatalan sudah lewat (${booking.paket.manifestClosesAt.toISOString().slice(0, 10)}). Silakan hubungi admin atau agen Anda untuk proses pembatalan.`,
      'CANCEL_DEADLINE_PASSED',
    );
  }
  const updated = await db.booking.update({
    where: { id: bookingId },
    data: {
      cancelRequested: true,
      cancelRequestedAt: new Date(),
      cancelRequestReason: reason.trim(),
    },
  });
  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'Booking', entityId: bookingId,
    before: { cancelRequested: false },
    after: {
      cancelRequested: true,
      cancelRequestReason: reason.trim(),
      bookingNo: booking.bookingNo,
      requestedBy: actor.email,
    },
  });

  // Notif admin (non-blocking — request must succeed even if email fails)
  try {
    const bookingForNotif = await db.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true, bookingNo: true, kelas: true, paxCount: true, paidAmount: true,
        jemaah: { select: { fullName: true, phone: true } },
        paket: { select: { title: true } },
      },
    });
    if (bookingForNotif) {
      await notifyCancelRequested({
        booking: bookingForNotif,
        reason: reason.trim(),
        requestedByEmail: actor.email,
      });
    }
  } catch (err) {
    console.error('[cancel-request] notif failed:', err.message);
  }

  return updated;
}

/**
 * Stage 340 — jemaah-initiated reschedule request. Mirrors
 * `requestCancelByJemaah` shape:
 *   - Validates reason ≥3 chars
 *   - Booking must be owned by user + not terminal
 *   - One pending request at a time (no stacking)
 *   - Optional `targetPaketId` preference (admin sees it in the modal
 *     pre-fill but isn't bound by it)
 *   - **No manifestClosesAt deadline check** — reschedule is the
 *     opposite of cancel; jemaah late in the cycle still benefits from
 *     a clean reschedule path (the admin still gates capacity/timing
 *     via the S337 modal). Different from S147 cancel-deadline because
 *     a reschedule doesn't release the kursi the way cancel does.
 */
export async function requestRescheduleByJemaah({
  req, actor, userId, bookingId, reason, targetPaketId = null,
}) {
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(400, 'Alasan reschedule wajib (min. 3 karakter)', 'RESCHEDULE_REASON_REQUIRED');
  }
  const booking = await db.booking.findFirst({
    where: { id: bookingId, jemaahUserId: userId },
    select: {
      id: true, bookingNo: true, status: true, rescheduleRequested: true,
      paketId: true,
      jemaah: { select: { fullName: true, phone: true, email: true } },
      paket: { select: { title: true } },
    },
  });
  if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  const TERMINAL = new Set(['CANCELLED', 'REFUNDED', 'RESCHEDULED']);
  if (TERMINAL.has(booking.status)) {
    throw new HttpError(409, `Booking sudah ${booking.status}`, 'ALREADY_CLOSED');
  }
  if (booking.rescheduleRequested) {
    throw new HttpError(409, 'Permintaan reschedule sebelumnya masih diproses admin', 'ALREADY_REQUESTED');
  }
  if (targetPaketId && targetPaketId === booking.paketId) {
    throw new HttpError(409, 'Paket target sama dengan paket saat ini', 'SAME_PAKET');
  }

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: {
      rescheduleRequested: true,
      rescheduleRequestedAt: new Date(),
      rescheduleRequestReason: reason.trim(),
      rescheduleRequestTargetPaketId: targetPaketId || null,
    },
  });
  await audit({
    req, actor,
    action: 'STATUS_CHANGE', entity: 'Booking', entityId: bookingId,
    before: { rescheduleRequested: false },
    after: {
      rescheduleRequested: true,
      rescheduleRequestReason: reason.trim(),
      rescheduleRequestTargetPaketId: targetPaketId || null,
      bookingNo: booking.bookingNo,
      requestedBy: actor.email,
    },
  });

  // S342 — fire-and-forget notif fan-out to admin tier
  try {
    const { notifyRescheduleRequested } = await import('./notifications.js');
    await notifyRescheduleRequested({
      booking: {
        id: booking.id, bookingNo: booking.bookingNo,
        jemaah: booking.jemaah, paket: booking.paket,
      },
      reason: reason.trim(),
      targetPaketId,
      requestedByEmail: actor.email,
    });
  } catch (err) {
    console.warn('[reschedule-request] notif failed:', err?.message || err);
  }

  return updated;
}

/**
 * Read-only notif inbox for a jemaah (5ll). Filters strictly on
 * `Notification.recipientUserId = userId` so admin/system rows never leak in.
 * Caps at 50 — UI is a "recent activity" feed, not a full archive.
 */
export async function listMyNotifications(userId, { limit = 50 } = {}) {
  return db.notification.findMany({
    where: { recipientUserId: userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, type: true, channel: true, status: true,
      subject: true, body: true,
      relatedEntity: true, relatedEntityId: true,
      sentAt: true, createdAt: true, error: true,
      readAt: true,
    },
  });
}

/**
 * Stage 181 — paginated full notification history. /saya, /agen, /crew
 * inbox views switch to this once the list overflows the page 1 default.
 * Page size clamped to [1..100], page floors to 1 on negative values.
 *
 * Same query shape as the unpaginated helper (`select` columns identical)
 * so partials don't need to branch.
 */
export async function listMyNotificationsPaginated(userId, {
  page = 1, pageSize = 50,
} = {}) {
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 50)));
  const skip = (safePage - 1) * safeSize;
  const [rows, total] = await Promise.all([
    db.notification.findMany({
      where: { recipientUserId: userId },
      orderBy: { createdAt: 'desc' },
      skip, take: safeSize,
      select: {
        id: true, type: true, channel: true, status: true,
        subject: true, body: true,
        relatedEntity: true, relatedEntityId: true,
        sentAt: true, createdAt: true, error: true,
        readAt: true,
      },
    }),
    db.notification.count({ where: { recipientUserId: userId } }),
  ]);
  return {
    rows, total,
    pagination: {
      page: safePage, pageSize: safeSize,
      pageCount: Math.max(1, Math.ceil(total / safeSize)),
    },
  };
}

/**
 * 5rr: count of unread notifs for the unread badge in the jemaah sidebar.
 * Cheap query (composite index `[recipientUserId, readAt]`).
 */
export async function countUnreadForUser(userId) {
  return db.notification.count({
    where: { recipientUserId: userId, readAt: null },
  });
}

/**
 * 5rr: stamp all currently-unread notifs for the user as read. Called when
 * the jemaah opens their inbox — by the next page render the badge clears.
 * Returns the count that were marked.
 */
export async function markAllReadForUser(userId) {
  const r = await db.notification.updateMany({
    where: { recipientUserId: userId, readAt: null },
    data: { readAt: new Date() },
  });
  return r.count;
}

/**
 * Read-only booking detail scoped to this user. 404 if not owned.
 */
export async function getMyBooking(userId, bookingId) {
  const booking = await db.booking.findFirst({
    where: { id: bookingId, jemaahUserId: userId },
    include: {
      paket: {
        select: {
          slug: true, title: true, departureDate: true, returnDate: true,
          durationDays: true, airline: true, routeFrom: true, routeTo: true,
          manifestClosesAt: true, waGroupUrl: true,
          // Stage 322 — itinerary timeline on jemaah booking detail
          days: { orderBy: { dayNumber: 'asc' }, select: { dayNumber: true, title: true, description: true } },
        },
      },
      jemaah: { include: { documents: { orderBy: { type: 'asc' } } } },
      agent: { select: { slug: true, displayName: true, whatsapp: true } },
      room: { select: { roomNo: true, floor: true, wing: true } },
      // Stage 202 — current pickup choice (S196). null when jemaah
      // hasn't picked yet ("TBD").
      pickup: { select: { id: true, label: true, address: true, departTime: true } },
      payments: { orderBy: { createdAt: 'desc' } },
    },
  });
  return booking;
}
