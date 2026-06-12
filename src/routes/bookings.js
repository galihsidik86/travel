import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { db } from '../lib/db.js';
import { getBookingById, cancelBooking, updateBookingNotes, transferBookingAgent, toggleBookingNotesPinned, declineCancelRequest, setBookingTags, BOOKING_TAG_PRESETS } from '../services/bookingAdmin.js';
import { searchStaffForMention } from '../services/userAdmin.js';
import { listIntentsForBooking, cancelStuckIntent } from '../services/paymentGateway.js';
import { createBooking } from '../services/booking.js';
import { searchBookings } from '../services/bookingsSearch.js';
import { getAdminBookingVoucher } from '../services/bookingVoucher.js';

const router = Router();

// view = 4 roles, cancel = 3 roles (KASIR not allowed to cancel)
const VIEW_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR'];
const CANCEL_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];
const CREATE_ROLES = VIEW_ROLES; // any admin role can create a walk-in booking

router.use(requireAuth);

function actorFrom(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

const CANCEL_REASON_CODES = [
  'JEMAAH_REQUEST', 'PAKET_CANCELLED', 'PAYMENT_NOT_RECEIVED',
  'DOCUMENT_INCOMPLETE', 'NO_SHOW', 'GOODWILL', 'OTHER',
];
const CancelSchema = z.object({
  reason: z.string().min(3, 'Alasan minimal 3 karakter').max(2000),
  // Stage 175 — optional structured category. Empty string normalises
  // to null so the form's "— pilih kategori —" default doesn't fail.
  reasonCode: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim().toUpperCase()),
    z.enum(CANCEL_REASON_CODES).nullable().optional(),
  ),
});

// ── GET /admin/bookings/mention-search (S82 autocomplete) ────
// Returns up to 10 ACTIVE staff users matching ?q= substring as JSON.
// Same RBAC as cancel/notes-edit — KASIR is view-only on notes, so they
// don't get the dropdown either.
router.get(
  '/mention-search',
  requireRole(...CANCEL_ROLES),
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').toString();
    const rows = await searchStaffForMention({ q });
    res.json({ rows });
  }),
);

// ── GET /admin/bookings/shortcode-search (S88 autocomplete) ──
// Code-only substring match. Returns top 10 with resolved user.
router.get(
  '/shortcode-search',
  requireRole(...CANCEL_ROLES),
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    if (q.length < 1) return res.json({ rows: [] });
    const rows = await db.mentionShortcode.findMany({
      where: {
        code: { contains: q },
        user: { deletedAt: null, status: 'ACTIVE', email: { not: '' } },
      },
      take: 10,
      orderBy: { code: 'asc' },
      select: {
        code: true,
        user: { select: { email: true, fullName: true, role: true } },
      },
    });
    res.json({ rows });
  }),
);

// ── GET /admin/bookings (global search) ──────────────────────
router.get(
  '/',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const filters = {
      q: (req.query.q || '').toString(),
      // Stage 184 — substring search on Booking.notes (≥3 chars required)
      notes: (req.query.notes || '').toString(),
      status: req.query.status || 'ALL',
      paketId: req.query.paketId || 'ALL',
      agentId: req.query.agentId || 'ALL',
      // Stage 182 — cancel reason filter (enum value, '__UNSET__', or 'ALL')
      cancelReasonCode: req.query.cancelReasonCode || 'ALL',
      from: req.query.from || '',
      to: req.query.to || '',
      page: req.query.page || 1,
    };
    const [result, paketOpts, agentOpts] = await Promise.all([
      searchBookings(filters),
      db.paket.findMany({
        where: { deletedAt: null, status: { not: 'ARCHIVED' } },
        select: { id: true, slug: true, title: true },
        orderBy: { departureDate: 'desc' },
      }),
      db.agentProfile.findMany({
        select: { id: true, slug: true, displayName: true },
        orderBy: { displayName: 'asc' },
      }),
    ]);
    res.render('bookings-list', {
      user: req.user,
      ...result,
      filters,
      paketOpts, agentOpts,
    });
  }),
);

// ── GET /admin/bookings/new (walk-in booking form) ───────────
router.get(
  '/new',
  requireRole(...CREATE_ROLES),
  asyncHandler(async (req, res) => {
    const [paketList, agents] = await Promise.all([
      db.paket.findMany({
        where: { status: 'ACTIVE', deletedAt: null },
        select: { slug: true, title: true, departureDate: true,
          prices: { select: { kelas: true, priceIdr: true, isFeatured: true } } },
        orderBy: { departureDate: 'asc' },
      }),
      db.agentProfile.findMany({
        select: { slug: true, displayName: true },
        orderBy: { displayName: 'asc' },
      }),
    ]);
    res.render('booking-new', {
      user: req.user, paketList, agents,
      error: null, values: { paketSlug: '', agentSlug: '', fullName: '', phone: '', kelas: 'QUAD', paxCount: 1, notes: '' },
      duplicateBookings: null,
    });
  }),
);

// ── POST /admin/bookings (create walk-in) ────────────────────
const NewBookingSchema = z.object({
  paketSlug: z.string().min(1, 'Pilih paket'),
  agentSlug: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  fullName: z.string().min(2, 'Nama lengkap minimal 2 karakter').max(190),
  phone: z.string().min(8, 'Telepon minimal 8 karakter').max(30),
  // Stage 209 — optional NIK for the dup check. Skipped when blank.
  nik: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).replace(/\D+/g, '')),
    z.string().min(10, 'NIK minimal 10 digit').max(20).nullable().optional(),
  ).optional(),
  kelas: z.enum(['QUAD', 'TRIPLE', 'DOUBLE', 'VVIP']),
  paxCount: z.preprocess((v) => Number(v), z.number().int().min(1).max(20)),
  notes: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().max(2000).nullable()),
});

router.post(
  '/',
  requireRole(...CREATE_ROLES),
  asyncHandler(async (req, res) => {
    const reloadForm = async (error, values) => {
      const [paketList, agents] = await Promise.all([
        db.paket.findMany({
          where: { status: 'ACTIVE', deletedAt: null },
          select: { slug: true, title: true, departureDate: true,
            prices: { select: { kelas: true, priceIdr: true, isFeatured: true } } },
          orderBy: { departureDate: 'asc' },
        }),
        db.agentProfile.findMany({
          select: { slug: true, displayName: true },
          orderBy: { displayName: 'asc' },
        }),
      ]);
      return res.status(400).render('booking-new', { user: req.user, paketList, agents, error, values, duplicateBookings: null });
    };

    try {
      const data = NewBookingSchema.parse(req.body);
      // Stage 167 — duplicate phone warning before create.
      // Stage 209 — also checks NIK when admin provided one. Phone
      // dupes might be family members sharing a number; NIK dupes
      // are LITERALLY the same person — distinct severity signals.
      // Admin explicitly confirms via the `confirmDuplicate` checkbox.
      const confirmed = req.body?.confirmDuplicate === 'on' || req.body?.confirmDuplicate === 'true';
      if (!confirmed) {
        const { findRecentBookingsByPhone, findRecentBookingsByNik } =
          await import('../services/bookingDuplicateCheck.js');
        const [phoneDupes, nikDupes] = await Promise.all([
          findRecentBookingsByPhone({ phone: data.phone }),
          data.nik ? findRecentBookingsByNik({ nik: data.nik }) : Promise.resolve([]),
        ]);
        // Merge by id so a booking matching BOTH phone + NIK doesn't
        // double-render; track which signal(s) flagged each one for
        // the UI.
        const flagsById = new Map();
        for (const b of phoneDupes) flagsById.set(b.id, { booking: b, flags: ['phone'] });
        for (const b of nikDupes) {
          const existing = flagsById.get(b.id);
          if (existing) existing.flags.push('nik');
          else flagsById.set(b.id, { booking: b, flags: ['nik'] });
        }
        const dupes = [...flagsById.values()].map((entry) => ({
          ...entry.booking, dupFlags: entry.flags,
        }));
        if (dupes.length > 0) {
          // Re-render with warning panel; preserve user input so they
          // don't have to retype. POST → status 200 (not an error) so
          // intermediate proxies don't strip the form.
          const [paketList, agents] = await Promise.all([
            db.paket.findMany({
              where: { status: 'ACTIVE', deletedAt: null },
              select: { slug: true, title: true, departureDate: true,
                prices: { select: { kelas: true, priceIdr: true, isFeatured: true } } },
              orderBy: { departureDate: 'asc' },
            }),
            db.agentProfile.findMany({
              select: { slug: true, displayName: true },
              orderBy: { displayName: 'asc' },
            }),
          ]);
          return res.render('booking-new', {
            user: req.user, paketList, agents,
            error: null, values: req.body || {},
            duplicateBookings: dupes,
          });
        }
      }
      const result = await createBooking({
        req, ...data,
        adminCreator: actorFrom(req),
      });
      res.redirect(`/admin/bookings/${result.booking.id}?ok=created`);
    } catch (err) {
      const msg = err.issues?.[0]?.message || err.message || 'Gagal membuat booking';
      return reloadForm(msg, req.body || {});
    }
  }),
);

// ── GET /admin/bookings/:id ──────────────────────────────────
// ── Stage 180 — booking note templates CRUD ──────────────────
// Listing readable by any VIEW role so the dropdown populates for
// MANAJER_OPS + KASIR too. Mutations gated to OWNER+SUPERADMIN.
const NOTE_TPL_EDIT_ROLES = ['OWNER', 'SUPERADMIN'];

router.get(
  '/note-templates',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const { listNoteTemplates } = await import('../services/bookingNoteTemplates.js');
    const templates = await listNoteTemplates();
    const editable = NOTE_TPL_EDIT_ROLES.includes(req.user.role);
    res.render('booking-note-templates', {
      user: req.user, templates, editable,
      flash: {
        ok: req.query.ok || null,
        err: req.query.err ? decodeURIComponent(req.query.err) : null,
      },
    });
  }),
);

router.post(
  '/note-templates',
  requireRole(...NOTE_TPL_EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { createNoteTemplate } = await import('../services/bookingNoteTemplates.js');
    try {
      await createNoteTemplate({
        req, actor: actorFrom(req),
        input: req.body || {},
      });
      res.redirect('/admin/bookings/note-templates?ok=created');
    } catch (err) {
      const msg = err?.issues?.[0]?.message || err?.message || 'Gagal simpan';
      res.redirect('/admin/bookings/note-templates?err=' + encodeURIComponent(msg));
    }
  }),
);

router.post(
  '/note-templates/:id',
  requireRole(...NOTE_TPL_EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { updateNoteTemplate } = await import('../services/bookingNoteTemplates.js');
    try {
      await updateNoteTemplate({
        req, actor: actorFrom(req),
        id: req.params.id, input: req.body || {},
      });
      res.redirect('/admin/bookings/note-templates?ok=updated');
    } catch (err) {
      const msg = err?.issues?.[0]?.message || err?.message || 'Gagal simpan';
      res.redirect('/admin/bookings/note-templates?err=' + encodeURIComponent(msg));
    }
  }),
);

router.post(
  '/note-templates/:id/delete',
  requireRole(...NOTE_TPL_EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const { deleteNoteTemplate } = await import('../services/bookingNoteTemplates.js');
    try {
      await deleteNoteTemplate({
        req, actor: actorFrom(req), id: req.params.id,
      });
      res.redirect('/admin/bookings/note-templates?ok=deleted');
    } catch (err) {
      const msg = err?.message || 'Gagal hapus';
      res.redirect('/admin/bookings/note-templates?err=' + encodeURIComponent(msg));
    }
  }),
);

router.get(
  '/:id',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const booking = await getBookingById(req.params.id);
    if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
    const canCancel = CANCEL_ROLES.includes(req.user.role)
      && booking.status !== 'CANCELLED' && booking.status !== 'REFUNDED';
    const paid = Number(booking.paidAmount?.toString?.() ?? booking.paidAmount) || 0;
    const canRefund = CANCEL_ROLES.includes(req.user.role)
      && booking.status === 'CANCELLED' && paid > 0;
    const canEditNotes = CANCEL_ROLES.includes(req.user.role);
    const canTransfer = CANCEL_ROLES.includes(req.user.role)
      && booking.status !== 'CANCELLED' && booking.status !== 'REFUNDED';
    // Active agents for the transfer dropdown (cheap query, small N)
    const agents = canTransfer
      ? await db.agentProfile.findMany({
          select: { id: true, slug: true, displayName: true },
          orderBy: { displayName: 'asc' },
        })
      : [];
    // 5qq: payment intent history for this booking
    const paymentIntents = await listIntentsForBooking(booking.id);
    const canCancelIntent = CANCEL_ROLES.includes(req.user.role);
    // Stage 98 — unified activity feed (audit + payments + tasks + mentions + …)
    const { getBookingActivityFeed } = await import('../services/bookingActivity.js');
    const activityFeed = await getBookingActivityFeed(booking.id)
      .catch((err) => { console.warn('[booking-detail] activity feed failed:', err?.message || err); return null; });
    // Stage 180 — note templates for the quick-insert dropdown above the
    // notes textarea. Only loaded when the viewer can edit notes.
    let noteTemplates = [];
    if (canEditNotes) {
      const { listNoteTemplates } = await import('../services/bookingNoteTemplates.js');
      noteTemplates = await listNoteTemplates()
        .catch((err) => { console.warn('[booking-detail] note templates failed:', err?.message || err); return []; });
    }
    // Stage 221 — paket pickups for the admin pickup-set dropdown. Same
    // RBAC as cancel/edit. Best-effort — missing pickups just hides the
    // dropdown, doesn't 500 the page.
    const canSetPickup = CANCEL_ROLES.includes(req.user.role)
      && booking.status !== 'CANCELLED' && booking.status !== 'REFUNDED';
    let paketPickups = [];
    if (canSetPickup) {
      try {
        const { listPickupsWithOccupancy } = await import('../services/paketPickups.js');
        paketPickups = await listPickupsWithOccupancy(booking.paketId);
      } catch (err) {
        console.warn('[booking-detail] paket pickups failed:', err?.message || err);
      }
    }
    res.render('booking-detail', {
      user: req.user, b: booking,
      canCancel, canRefund, canEditNotes, canTransfer, agents,
      paymentIntents, canCancelIntent,
      activityFeed, noteTemplates,
      canSetPickup, paketPickups,
      // Stage 226 — tag presets for the booking-detail tag chip picker
      bookingTagPresets: BOOKING_TAG_PRESETS,
    });
  }),
);

// ── GET /admin/bookings/:id/print (stage 20 voucher) ─────────
router.get(
  '/:id/print',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const data = await getAdminBookingVoucher(req.params.id);
    res.render('booking-voucher', {
      user: req.user,
      ...data,
      backUrl: `/admin/bookings/${req.params.id}`,
    });
  }),
);

// ── GET /admin/bookings/:id/voucher.pdf (Stage 101 — PDF download) ──
// Stage 103: ?lang=id|en|ar optional (defaults to id).
router.get(
  '/:id/voucher.pdf',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const data = await getAdminBookingVoucher(req.params.id);
    // Stage 149 — cache-then-render. Hash invalidates when any
    // displayed field changes (status/paid/jemaah/room/agent/payments).
    const { getOrRenderVoucherPdf } = await import('../services/voucherCache.js');
    const { voucherFilename, pickLang } = await import('../services/bookingVoucherPdf.js');
    const lang = pickLang(req.query.lang);
    const { buffer, cached } = await getOrRenderVoucherPdf({
      bookingId: req.params.id, voucher: data, lang,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${voucherFilename(data, lang)}"`);
    res.setHeader('X-Voucher-Cache', cached ? 'HIT' : 'MISS');
    // Stage 198 — bump print history on finish (fire-and-forget)
    res.on('finish', async () => {
      const { recordVoucherPrint } = await import('../services/voucherPrintHistory.js');
      recordVoucherPrint({ bookingId: req.params.id, actorEmail: req.user?.email || null });
    });
    res.end(buffer);
  }),
);

// ── GET /admin/bookings/:id/bundle.zip (Stage 105 — dossier export) ──
// Stage 106: ?format=csv swaps voucher.pdf for booking/payments/docs CSVs.
router.get(
  '/:id/bundle.zip',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const data = await getAdminBookingVoucher(req.params.id);
    const { streamBookingBundle } = await import('../services/bookingBundle.js');
    const format = (req.query.format || 'pdf').toString().toLowerCase();
    await streamBookingBundle(data, res, { format: format === 'csv' ? 'csv' : 'pdf' });
  }),
);

// ── POST /admin/bookings/:id/notes ───────────────────────────
const NotesSchema = z.object({
  notes: z.string().max(2000).optional(),
});

router.post(
  '/:id/notes',
  requireRole(...CANCEL_ROLES),
  asyncHandler(async (req, res) => {
    try {
      const { notes } = NotesSchema.parse(req.body);
      await updateBookingNotes({
        req, actor: actorFrom(req),
        bookingId: req.params.id, notes: notes ?? '',
      });
      res.redirect(`/admin/bookings/${req.params.id}?ok=notes`);
    } catch (err) {
      const msg = err.issues?.[0]?.message || err.message || 'Gagal simpan catatan';
      res.redirect(`/admin/bookings/${req.params.id}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// Stage 206 — toggle the pinned-banner flag for booking notes.
router.post(
  '/:id/notes/pin',
  requireRole(...CANCEL_ROLES),
  asyncHandler(async (req, res) => {
    try {
      // form sends `pinned=true|false`; JSON callers pass boolean
      const raw = req.body?.pinned;
      const pinned = raw === true || raw === 'true' || raw === 'on';
      await toggleBookingNotesPinned({
        req, actor: actorFrom(req),
        bookingId: req.params.id, pinned,
      });
      res.redirect(`/admin/bookings/${req.params.id}?ok=notes_pin`);
    } catch (err) {
      const msg = err.message || 'Gagal pin catatan';
      res.redirect(`/admin/bookings/${req.params.id}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// Stage 221 — admin sets pickup on a booking. Useful for walk-in /
// phone bookings where jemaah doesn't have a /saya account. Same
// capacity + cross-paket guards as the S202 jemaah self-pick.
router.post(
  '/:id/pickup',
  requireRole(...CANCEL_ROLES),
  asyncHandler(async (req, res) => {
    try {
      const { adminSetBookingPickup } = await import('../services/bookingPickupChoice.js');
      const pickupId = (req.body?.pickupId || '').toString();
      await adminSetBookingPickup({
        req, actor: actorFrom(req),
        bookingId: req.params.id,
        pickupId: pickupId || null,
      });
      res.redirect(`/admin/bookings/${req.params.id}?ok=pickup`);
    } catch (err) {
      const msg = err.message || 'Gagal set pickup';
      res.redirect(`/admin/bookings/${req.params.id}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// ── POST /admin/bookings/:id/transfer-agent ──────────────────
const TransferSchema = z.object({
  toAgentId: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  reason: z.string().min(3, 'Alasan transfer min. 3 karakter').max(2000),
  includeEarnedKomisi: z.preprocess(
    (v) => v === 'on' || v === true || v === 'true',
    z.boolean(),
  ).default(false),
});

router.post(
  '/:id/transfer-agent',
  requireRole(...CANCEL_ROLES),
  asyncHandler(async (req, res) => {
    try {
      const data = TransferSchema.parse(req.body);
      await transferBookingAgent({
        req, actor: actorFrom(req),
        bookingId: req.params.id,
        toAgentId: data.toAgentId,
        reason: data.reason,
        includeEarnedKomisi: data.includeEarnedKomisi,
      });
      res.redirect(`/admin/bookings/${req.params.id}?ok=transferred`);
    } catch (err) {
      const msg = err.issues?.[0]?.message || err.message || 'Gagal transfer';
      res.redirect(`/admin/bookings/${req.params.id}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// ── POST /admin/bookings/:id/cancel ──────────────────────────
router.post(
  '/:id/cancel',
  requireRole(...CANCEL_ROLES),
  asyncHandler(async (req, res) => {
    try {
      const { reason, reasonCode } = CancelSchema.parse(req.body);
      await cancelBooking({
        req, actor: actorFrom(req),
        bookingId: req.params.id, reason, reasonCode: reasonCode ?? null,
      });
      res.redirect(`/admin/bookings/${req.params.id}?ok=cancelled`);
    } catch (err) {
      const msg = err.issues?.[0]?.message || err.message || 'Gagal cancel';
      res.redirect(`/admin/bookings/${req.params.id}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// Stage 226 — set booking tags. Accepts JSON `tags: []` OR form-encoded
// `tags=VIP,LANSIA` (CSV string parsed by normaliseBookingTags).
router.post(
  '/:id/tags',
  requireRole(...CANCEL_ROLES),
  asyncHandler(async (req, res) => {
    try {
      const raw = req.body?.tags;
      await setBookingTags({
        req, actor: actorFrom(req),
        bookingId: req.params.id, tags: raw,
      });
      res.redirect(`/admin/bookings/${req.params.id}?ok=tags`);
    } catch (err) {
      const msg = err.message || 'Gagal simpan tag';
      res.redirect(`/admin/bookings/${req.params.id}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// Stage 224 — admin declines a jemaah's cancel request. Distinct from
// the /cancel route (which actually cancels). Clears the request flag,
// notifies jemaah back with admin's reason.
router.post(
  '/:id/cancel-request/decline',
  requireRole(...CANCEL_ROLES),
  asyncHandler(async (req, res) => {
    try {
      await declineCancelRequest({
        req, actor: actorFrom(req),
        bookingId: req.params.id,
        reason: (req.body?.reason || '').toString(),
      });
      res.redirect(`/admin/bookings/${req.params.id}?ok=request_declined`);
    } catch (err) {
      const msg = err.message || 'Gagal tolak request';
      res.redirect(`/admin/bookings/${req.params.id}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// ── POST /admin/bookings/:id/intents/:intentId/cancel ────────
// 5qq: cancel a stuck CREATED/PENDING PaymentIntent so a fresh one can be created.
// SETTLED intents → refused (refund flow handles already-paid).
router.post(
  '/:id/intents/:intentId/cancel',
  requireRole(...CANCEL_ROLES),
  asyncHandler(async (req, res) => {
    try {
      await cancelStuckIntent({
        req, actor: actorFrom(req),
        intentId: req.params.intentId,
        reason: req.body?.reason || '',
      });
      res.redirect(`/admin/bookings/${req.params.id}?ok=intent_cancelled`);
    } catch (err) {
      const msg = err.message || 'Gagal cancel intent';
      res.redirect(`/admin/bookings/${req.params.id}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

export default router;
