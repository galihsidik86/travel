// Jemaah self-service portal. Includes the public HTML register flow + the
// post-login dashboard at /saya.
import { Router } from 'express';
import { z } from 'zod';

import { db } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { signToken, COOKIE_NAME, cookieOptions } from '../lib/jwt.js';
import { audit } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { HttpError } from '../middleware/error.js';
import {
  ClaimSchema, getMyDashboard, claimBooking, getMyBooking,
  updateMyProfile, submitMyDoc, deleteMyDoc,
  listAvailablePaket, requestCancelByJemaah,
  listMyNotifications, countUnreadForUser, markAllReadForUser,
  setMyNotifTypePrefs, getMyNotifTypePrefs, JEMAAH_NOTIF_TYPES,
} from '../services/jemaahPortal.js';
import { DOC_TYPES, DOC_STATUSES, DOC_PILL } from '../services/jemaahDocs.js';
import { META as JEMAAH_META } from '../services/jemaahAdmin.js';
import {
  uploadMyDocFile, deleteMyDocFile, getMyDocFileMeta,
} from '../services/jemaahDocFiles.js';
import { uploadSingleDoc } from '../middleware/docUpload.js';

const router = Router();

const registerLimiter = rateLimit({ windowMs: 60_000, max: 5, code: 'REGISTER_RATE_LIMITED' });

// ─── Public: HTML register ───────────────────────────────────
const RegisterSchema = z.object({
  email: z.string().email('Email tidak valid').max(190).toLowerCase(),
  password: z.string().min(8, 'Password minimal 8 karakter').max(200),
  fullName: z.string().min(2, 'Nama minimal 2 karakter').max(190),
  phone: z.string().min(8, 'Nomor telepon tidak valid').max(30),
});

router.get('/register', (req, res) => {
  res.render('register', { error: null, values: { email: '', fullName: '', phone: '' } });
});

router.post(
  '/register',
  registerLimiter,
  asyncHandler(async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).render('register', {
        error: parsed.error.issues[0]?.message || 'Periksa isian',
        values: { email: req.body?.email || '', fullName: req.body?.fullName || '', phone: req.body?.phone || '' },
      });
    }
    const data = parsed.data;

    const existing = await db.user.findUnique({ where: { email: data.email } });
    if (existing) {
      return res.status(409).render('register', {
        error: 'Email sudah terdaftar — silakan login',
        values: { email: data.email, fullName: data.fullName, phone: data.phone },
      });
    }

    const passwordHash = await hashPassword(data.password);
    const user = await db.user.create({
      data: {
        email: data.email, passwordHash, role: 'JEMAAH',
        fullName: data.fullName, phone: data.phone,
        jemaah: { create: { fullName: data.fullName, phone: data.phone } },
      },
    });
    await audit({
      req,
      actor: { id: user.id, email: user.email, role: user.role },
      action: 'CREATE', entity: 'User', entityId: user.id,
      after: { email: user.email, role: user.role, via: 'self-register' },
    });

    const token = signToken({ sub: user.id, role: user.role, email: user.email });
    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.redirect('/saya?welcome=1');
  }),
);

// ─── Authenticated /saya — dashboard + claim + my booking ────
router.use('/saya', requireAuth, requireRole('JEMAAH'));

router.get(
  '/saya',
  asyncHandler(async (req, res) => {
    const [data, unreadCount] = await Promise.all([
      getMyDashboard(req.user.id),
      countUnreadForUser(req.user.id),
    ]);
    res.render('jemaah-portal', { user: req.user, ...data, unreadCount });
  }),
);

router.get(
  '/saya/paket',
  asyncHandler(async (req, res) => {
    const paketList = await listAvailablePaket(req.user.id);
    res.render('jemaah-paket-list', { user: req.user, paketList });
  }),
);

router.get(
  '/saya/bookings/:id',
  asyncHandler(async (req, res) => {
    const booking = await getMyBooking(req.user.id, req.params.id);
    if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
    // 5xx: surface the latest non-terminal intent (if any) so the view can
    // render a polling card while waiting for VA/QRIS to settle.
    const { getActiveIntentForJemaahBooking } = await import('../services/paymentGateway.js');
    const activeIntent = await getActiveIntentForJemaahBooking({ userId: req.user.id, bookingId: req.params.id });
    res.render('jemaah-booking', { user: req.user, b: booking, activeIntent });
  }),
);

router.get(
  '/saya/notifications',
  asyncHandler(async (req, res) => {
    // Fetch BEFORE marking-as-read so the rendered list still shows the
    // pre-read state (i.e. we can highlight rows that *were* unread this
    // visit). The actual stamp clears the badge for the next page render.
    const notifications = await listMyNotifications(req.user.id);
    await markAllReadForUser(req.user.id);
    res.render('jemaah-notifications', { user: req.user, notifications });
  }),
);

// ── Profile editor ───────────────────────────────────────────
router.get(
  '/saya/profile',
  asyncHandler(async (req, res) => {
    const profile = await db.jemaahProfile.findFirst({
      where: { userId: req.user.id },
      include: { documents: { orderBy: { type: 'asc' } } },
    });
    if (!profile) throw new HttpError(404, 'Profil belum dibuat', 'PROFILE_NOT_FOUND');
    const target = {
      ...profile,
      passportExpiry: profile.passportExpiry?.toISOString().slice(0, 10) || '',
      birthDate: profile.birthDate?.toISOString().slice(0, 10) || '',
    };
    const notifTypePrefs = await getMyNotifTypePrefs(req.user.id);
    res.render('jemaah-profile', {
      user: req.user, target, error: null,
      DOC_TYPES, DOC_STATUSES, DOC_PILL,
      META: JEMAAH_META,
      notifTypePrefs, JEMAAH_NOTIF_TYPES,
    });
  }),
);

// /api/saya/* lives outside the /saya prefix, so the router.use guard above
// doesn't reach it. Apply requireAuth+requireRole inline.
const requireJemaah = [requireAuth, requireRole('JEMAAH')];

router.post(
  '/api/saya/profile',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    // Normalize notif prefs: unchecked HTML checkbox is absent from body,
    // so we set explicit false here. Without this, an unchecked toggle would
    // be "no change" instead of "opt out". (5jj)
    const input = {
      ...req.body,
      notifWa: req.body?.notifWa ?? false,
      notifEmail: req.body?.notifEmail ?? false,
    };
    const actor = { id: req.user.id, email: req.user.email, role: req.user.role };
    const updated = await updateMyProfile({ req, actor, userId: req.user.id, input });

    // Per-type notif prefs (same checkbox normalisation — unchecked = false).
    // Form field name convention: notifType_<TYPE>=on (checkbox semantics).
    const typePrefs = {};
    for (const t of JEMAAH_NOTIF_TYPES) {
      const raw = req.body?.[`notifType_${t}`];
      typePrefs[t] = (raw === 'on' || raw === true || raw === 'true');
    }
    const typeState = await setMyNotifTypePrefs({ req, actor, userId: req.user.id, prefs: typePrefs });

    res.json({ jemaah: updated, notifTypePrefs: typeState });
  }),
);

router.post(
  '/api/saya/documents',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const doc = await submitMyDoc({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      userId: req.user.id, input: req.body,
    });
    res.status(201).json({ doc });
  }),
);

router.post(
  '/api/saya/bookings/:id/request-cancel',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const reason = (req.body?.reason || '').toString();
    await requestCancelByJemaah({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      userId: req.user.id, bookingId: req.params.id, reason,
    });
    res.json({ ok: true });
  }),
);

router.delete(
  '/api/saya/documents/:docId',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    await deleteMyDoc({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      userId: req.user.id, docId: req.params.docId,
    });
    res.json({ ok: true });
  }),
);

// ── 5mm: document file upload / download / delete ────────────
router.post(
  '/api/saya/documents/:docId/file',
  ...requireJemaah,
  uploadSingleDoc,
  asyncHandler(async (req, res) => {
    const doc = await uploadMyDocFile({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      userId: req.user.id, docId: req.params.docId, file: req.file,
    });
    res.status(201).json({ doc });
  }),
);

router.delete(
  '/api/saya/documents/:docId/file',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const doc = await deleteMyDocFile({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      userId: req.user.id, docId: req.params.docId,
    });
    res.json({ doc });
  }),
);

router.get(
  '/saya/documents/:docId/file',
  asyncHandler(async (req, res) => {
    const meta = await getMyDocFileMeta({ userId: req.user.id, docId: req.params.docId });
    res.type(meta.mimeType || 'application/octet-stream');
    // `inline` so browsers preview PDFs/images directly; filename hint for "Save as".
    res.setHeader('Content-Disposition', `inline; filename="${meta.fileName || 'document'}"`);
    res.sendFile(meta.absPath);
  }),
);

// ─── API: claim ──────────────────────────────────────────────
const claimLimiter = rateLimit({ windowMs: 60_000, max: 10, code: 'CLAIM_RATE_LIMITED' });

router.post(
  '/api/saya/claim',
  requireAuth, requireRole('JEMAAH'), claimLimiter,
  asyncHandler(async (req, res) => {
    const { bookingNo, phone } = ClaimSchema.parse(req.body);
    const result = await claimBooking({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      userId: req.user.id, bookingNo, phone,
    });
    res.json(result);
  }),
);

export default router;
