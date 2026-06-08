import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { db } from '../lib/db.js';
import { getBookingById, cancelBooking, updateBookingNotes, transferBookingAgent } from '../services/bookingAdmin.js';
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

const CancelSchema = z.object({
  reason: z.string().min(3, 'Alasan minimal 3 karakter').max(2000),
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

// ── GET /admin/bookings (global search) ──────────────────────
router.get(
  '/',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const filters = {
      q: (req.query.q || '').toString(),
      status: req.query.status || 'ALL',
      paketId: req.query.paketId || 'ALL',
      agentId: req.query.agentId || 'ALL',
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
    });
  }),
);

// ── POST /admin/bookings (create walk-in) ────────────────────
const NewBookingSchema = z.object({
  paketSlug: z.string().min(1, 'Pilih paket'),
  agentSlug: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable()),
  fullName: z.string().min(2, 'Nama lengkap minimal 2 karakter').max(190),
  phone: z.string().min(8, 'Telepon minimal 8 karakter').max(30),
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
      return res.status(400).render('booking-new', { user: req.user, paketList, agents, error, values });
    };

    try {
      const data = NewBookingSchema.parse(req.body);
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
    res.render('booking-detail', {
      user: req.user, b: booking,
      canCancel, canRefund, canEditNotes, canTransfer, agents,
      paymentIntents, canCancelIntent,
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
      const { reason } = CancelSchema.parse(req.body);
      await cancelBooking({
        req, actor: actorFrom(req),
        bookingId: req.params.id, reason,
      });
      res.redirect(`/admin/bookings/${req.params.id}?ok=cancelled`);
    } catch (err) {
      const msg = err.issues?.[0]?.message || err.message || 'Gagal cancel';
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
