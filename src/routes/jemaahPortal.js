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
  listMyNotifications, listMyNotificationsPaginated,
  countUnreadForUser, markAllReadForUser,
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
        // S90 — stamp consentAt at registration so we have an authoritative
        // "first opt-in" timestamp tied to a real user action (not a
        // post-hoc backfill).
        jemaah: { create: { fullName: data.fullName, phone: data.phone, notifWaConsentAt: new Date() } },
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
    const [data, unreadCount, inTrip] = await Promise.all([
      getMyDashboard(req.user.id),
      countUnreadForUser(req.user.id),
      // Stage 320 — Hari Ini hero context (null when pre-trip / post-trip)
      (async () => {
        try {
          const { getInTripContext } = await import('../services/jemaahPortal.js');
          return await getInTripContext(req.user.id);
        } catch (err) {
          console.warn('[saya] inTrip context failed:', err?.message || err);
          return null;
        }
      })(),
    ]);
    res.render('jemaah-portal', { user: req.user, ...data, unreadCount, inTrip });
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
    // Stage 192 — admin-posted announcements for this paket. Best-effort
    // so a query failure doesn't break the booking detail page.
    let announcements = [];
    try {
      const { listActiveAnnouncements } = await import('../services/paketAnnouncements.js');
      announcements = await listActiveAnnouncements({ paketId: booking.paketId });
    } catch (err) {
      console.warn('[jemaah-booking] announcements load failed:', err?.message || err);
    }
    // Stage 196 — pickup points for the bus run. Stage 212 enriches with
    // occupancy so a "PENUH" badge can render on full buses.
    let pickups = [];
    try {
      const { listPickupsWithOccupancy } = await import('../services/paketPickups.js');
      pickups = await listPickupsWithOccupancy(booking.paketId);
    } catch (err) {
      console.warn('[jemaah-booking] pickups load failed:', err?.message || err);
    }
    // Stage 238 — sanitized booking activity timeline (jemaah-friendly).
    // Best-effort — load failure just hides the panel.
    let activity = null;
    try {
      const { getJemaahBookingActivity } = await import('../services/jemaahBookingActivity.js');
      activity = await getJemaahBookingActivity(booking.id);
    } catch (err) {
      console.warn('[jemaah-booking] activity load failed:', err?.message || err);
    }
    // Stage 264 — group view (privacy-sanitized sibling list). Best-effort.
    let groupView = null;
    if (booking.groupKey) {
      try {
        const { getJemaahGroupView } = await import('../services/jemaahGroupView.js');
        groupView = await getJemaahGroupView({
          groupKey: booking.groupKey,
          currentBookingId: booking.id,
        });
      } catch (err) {
        console.warn('[jemaah-booking] group view load failed:', err?.message || err);
      }
    }
    // Stage 286 — attached add-ons (read-only for jemaah)
    // Stage 288 — also pull active catalog so jemaah can request more
    let bookingAddons = [];
    let addonCatalog = [];
    try {
      const { listBookingAddons } = await import('../services/bookingAddons.js');
      const { listPaketAddons } = await import('../services/paketAddons.js');
      [bookingAddons, addonCatalog] = await Promise.all([
        listBookingAddons(booking.id),
        listPaketAddons(booking.paketId, { activeOnly: true }),
      ]);
    } catch (err) {
      console.warn('[jemaah-booking] addons load failed:', err?.message || err);
    }
    // Stage 350 — compute readiness card for the pre-trip panel.
    // Best-effort: failure just hides the panel.
    let readiness = null;
    try {
      const { computeReadinessForBooking, resolveRequiredDocs } = await import('../services/preDepartureChecklist.js');
      readiness = computeReadinessForBooking({
        booking,
        departureDate: booking.paket.departureDate,
        requiredDocs: resolveRequiredDocs(booking.paket.requiredDocs),
      });
    } catch (err) {
      console.warn('[jemaah-booking] readiness compute failed:', err?.message || err);
    }
    res.render('jemaah-booking', {
      user: req.user, b: booking, activeIntent, announcements, pickups, activity,
      groupView, bookingAddons, addonCatalog, query: req.query,
      readiness,
    });
  }),
);

// Stage 20 — jemaah-side voucher print path.
router.get(
  '/saya/bookings/:id/print',
  asyncHandler(async (req, res) => {
    const { getJemaahBookingVoucher } = await import('../services/bookingVoucher.js');
    const data = await getJemaahBookingVoucher(req.user.id, req.params.id);
    res.render('booking-voucher', {
      user: req.user,
      ...data,
      backUrl: `/saya/bookings/${req.params.id}`,
    });
  }),
);

// Stage 101 — jemaah-side voucher as PDF download. Stage 103: ?lang param.
router.get(
  '/saya/bookings/:id/voucher.pdf',
  asyncHandler(async (req, res) => {
    const { getJemaahBookingVoucher } = await import('../services/bookingVoucher.js');
    const data = await getJemaahBookingVoucher(req.user.id, req.params.id);
    // Stage 149 — same cache-then-render path as the admin route.
    const { getOrRenderVoucherPdf } = await import('../services/voucherCache.js');
    const { voucherFilename, pickLang } = await import('../services/bookingVoucherPdf.js');
    const lang = pickLang(req.query.lang);
    const { buffer, cached } = await getOrRenderVoucherPdf({
      bookingId: req.params.id, voucher: data, lang,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${voucherFilename(data, lang)}"`);
    res.setHeader('X-Voucher-Cache', cached ? 'HIT' : 'MISS');
    // Stage 198 — bump print history (fire-and-forget)
    res.on('finish', async () => {
      const { recordVoucherPrint } = await import('../services/voucherPrintHistory.js');
      recordVoucherPrint({ bookingId: req.params.id, actorEmail: req.user?.email || null });
    });
    res.end(buffer);
  }),
);

router.get(
  '/saya/notifications',
  asyncHandler(async (req, res) => {
    // Stage 181 — paginated history. Fetch BEFORE marking-as-read so the
    // rendered list still shows the pre-read state (i.e. we can highlight
    // rows that *were* unread this visit). The actual stamp clears the
    // badge for the next page render.
    const page = parseInt(req.query.page, 10) || 1;
    const { rows: notifications, total, pagination } =
      await listMyNotificationsPaginated(req.user.id, { page });
    await markAllReadForUser(req.user.id);
    res.render('jemaah-notifications', {
      user: req.user, notifications, total, pagination,
    });
  }),
);

// ── Stage 328-330: Ibadah counters (client-side IDB) ──────────
router.get(
  '/saya/ibadah',
  asyncHandler(async (req, res) => {
    res.render('jemaah-ibadah-hub', { user: req.user });
  }),
);
router.get(
  '/saya/ibadah/thawaf',
  asyncHandler(async (req, res) => {
    res.render('jemaah-ibadah-thawaf', { user: req.user });
  }),
);
router.get(
  '/saya/ibadah/sai',
  asyncHandler(async (req, res) => {
    res.render('jemaah-ibadah-sai', { user: req.user });
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
    // Stage 240 — surface latest deletion request (if any) so jemaah
    // sees the state of their request on the profile page.
    let deletionRequest = null;
    try {
      const { listMyDataDeletionRequests } = await import('../services/dataDeletionRequest.js');
      const rows = await listMyDataDeletionRequests({ userId: req.user.id });
      deletionRequest = rows[0] || null;
    } catch (err) {
      console.warn('[profile] deletionRequest load failed:', err?.message || err);
    }
    res.render('jemaah-profile', {
      user: req.user, target, error: null,
      DOC_TYPES, DOC_STATUSES, DOC_PILL,
      META: JEMAAH_META,
      notifTypePrefs, JEMAAH_NOTIF_TYPES,
      deletionRequest,
      query: req.query,
    });
  }),
);

// Stage 239 — jemaah self-service data export (UU PDP article 5).
// Streams a ZIP containing CSVs + uploaded doc files. Ownership
// enforced by the requireRole gate already applied to /saya/*.
router.get(
  '/saya/data-export.zip',
  asyncHandler(async (req, res) => {
    const { buildJemaahDataExportPayload, streamJemaahDataExport } = await import('../services/jemaahDataExport.js');
    const payload = await buildJemaahDataExportPayload({ userId: req.user.id });
    if (!payload) throw new HttpError(404, 'Profil tidak ditemukan', 'PROFILE_NOT_FOUND');
    const today = new Date().toISOString().slice(0, 10);
    const safeEmail = (req.user.email || 'jemaah').replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="religio_data_${safeEmail}_${today}.zip"`);
    await streamJemaahDataExport(payload, res);
  }),
);

// Stage 240 — jemaah submits a right-to-be-forgotten request (UU PDP).
router.post(
  '/saya/data-deletion-request',
  asyncHandler(async (req, res) => {
    try {
      const { submitDataDeletionRequest } = await import('../services/dataDeletionRequest.js');
      await submitDataDeletionRequest({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        userId: req.user.id,
        requestReason: (req.body?.requestReason || '').toString(),
      });
      res.redirect('/saya/profile?ok=deletion_requested');
    } catch (err) {
      const msg = err?.message || 'Gagal kirim permintaan';
      res.redirect('/saya/profile?err=' + encodeURIComponent(msg));
    }
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
      // Stage 309 — engagement opt-out (birthday + anniversary touches)
      notifEngagement: req.body?.notifEngagement ?? false,
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

// Stage 288 — jemaah requests an add-on. Form-encoded (redirect-after-POST
// since the form is on the booking-detail page, not fetch-driven).
router.post(
  '/api/saya/bookings/:id/addon-request',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    try {
      const { requestBookingAddon } = await import('../services/jemaahAddonRequest.js');
      await requestBookingAddon({
        req, userId: req.user.id,
        bookingId: req.params.id,
        addonId: (req.body?.addonId || '').toString(),
        quantity: req.body?.quantity ? Number(req.body.quantity) : 1,
      });
      res.redirect(`/saya/bookings/${req.params.id}?ok=addon_request`);
    } catch (err) {
      const msg = err?.message || 'Gagal kirim permintaan';
      res.redirect(`/saya/bookings/${req.params.id}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// Stage 202 — jemaah picks a pickup point from the S196 list
router.post(
  '/api/saya/bookings/:id/pickup',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const { setMyBookingPickup } = await import('../services/bookingPickupChoice.js');
    try {
      const r = await setMyBookingPickup({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        userId: req.user.id,
        bookingId: req.params.id,
        pickupId: req.body?.pickupId,
      });
      res.json(r);
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      res.status(status).json({
        error: { message: err?.message || 'Gagal', code: err?.code || 'ERROR' },
      });
    }
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

// Stage 340 — jemaah submits a reschedule request (admin still gates
// via S337 rescheduleBooking modal).
router.post(
  '/api/saya/bookings/:id/request-reschedule',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const reason = (req.body?.reason || '').toString();
    const targetPaketId = (req.body?.targetPaketId || '').toString() || null;
    const { requestRescheduleByJemaah } = await import('../services/jemaahPortal.js');
    try {
      await requestRescheduleByJemaah({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        userId: req.user.id, bookingId: req.params.id, reason, targetPaketId,
      });
      res.json({ ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.statusCode : 500;
      const code = err instanceof HttpError ? err.code : 'SERVER_ERROR';
      res.status(status).json({ ok: false, code, message: err?.message || 'Gagal' });
    }
  }),
);

// Stage 72 — ICS calendar export. Jemaah drops departure into phone
// calendar. Auth-gated (requires JEMAAH session) + getMyBooking enforces
// jemaahUserId ownership so cross-user enumeration returns 404.
router.get(
  '/saya/bookings/:id/calendar.ics',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const { generateBookingIcs } = await import('../services/bookingIcs.js');
    const out = await generateBookingIcs({
      userId: req.user.id, bookingId: req.params.id,
    });
    if (!out) return res.status(404).type('text/plain').send('Booking tidak ditemukan');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.body);
  }),
);

// Stage 69 — jemaah self-service testimonial submit. Lands in DRAFT for
// admin review (admin still controls what appears on /p/:slug).
//
// Eligibility:
//   - jemaah owns the booking (jemaahUserId == req.user.id)
//   - booking is LUNAS (you can only tell a story after you've actually
//     paid + travelled — DP-only bookings shouldn't earn a public voice)
//   - only one PUBLISHED-or-DRAFT testimonial per (jemaahUser, paket) —
//     prevents accidental duplicate submits on form refresh
const JemaahTestimonialSchema = z.object({
  body: z.string().min(20, 'Cerita minimal 20 karakter').max(2000),
  rating: z.preprocess((v) => Number(v), z.number().int().min(1).max(5)),
  jemaahCity: z.preprocess((v) => v === '' ? null : v, z.string().max(120).nullable().optional()),
});

router.get(
  '/saya/bookings/:id/testimonial',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const booking = await getMyBooking(req.user.id, req.params.id);
    if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
    if (booking.status !== 'LUNAS') {
      throw new HttpError(400, 'Testimonial hanya bisa ditulis setelah booking LUNAS', 'NOT_LUNAS');
    }
    // Surface existing submission (if any) so the form shows DRAFT/PUBLISHED state
    const existing = await db.testimonial.findFirst({
      where: {
        paketId: booking.paketId,
        // We match by jemaahName since Testimonial doesn't have a userId FK
        // and the same jemaah may have multiple bookings; the soft uniqueness
        // is (this paket × this jemaah's display name)
        jemaahName: booking.jemaah.fullName,
      },
      select: { id: true, status: true, body: true, rating: true, jemaahCity: true },
    });
    res.render('jemaah-testimonial', {
      user: req.user, booking, existing, errors: {}, formError: null,
    });
  }),
);

router.post(
  '/saya/bookings/:id/testimonial',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const booking = await getMyBooking(req.user.id, req.params.id);
    if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
    if (booking.status !== 'LUNAS') {
      throw new HttpError(400, 'Testimonial hanya bisa ditulis setelah booking LUNAS', 'NOT_LUNAS');
    }
    let parsed;
    try {
      parsed = JemaahTestimonialSchema.parse(req.body);
    } catch (err) {
      const errors = {};
      for (const issue of err.issues || []) {
        errors[issue.path.join('.')] = issue.message;
      }
      return res.status(400).render('jemaah-testimonial', {
        user: req.user, booking,
        existing: req.body, errors,
        formError: 'Periksa kembali isian form.',
      });
    }

    // Re-submit: if jemaah already has a testimonial for this paket+name,
    // UPDATE the existing row + flip back to DRAFT for re-review (similar
    // to S47 doc re-verify policy). This avoids duplicate rows on refresh.
    const existing = await db.testimonial.findFirst({
      where: { paketId: booking.paketId, jemaahName: booking.jemaah.fullName },
    });
    if (existing) {
      await db.testimonial.update({
        where: { id: existing.id },
        data: {
          body: parsed.body,
          rating: parsed.rating,
          jemaahCity: parsed.jemaahCity ?? null,
          status: 'DRAFT', // re-submit returns to admin review
          submittedByUserId: req.user.id, // Stage 70 — link for notif on publish
        },
      });
      await audit({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        action: 'UPDATE', entity: 'Testimonial', entityId: existing.id,
        after: { selfSubmit: true, reSubmit: true },
      });
    } else {
      const t = await db.testimonial.create({
        data: {
          paketId: booking.paketId,
          jemaahName: booking.jemaah.fullName,
          jemaahCity: parsed.jemaahCity ?? null,
          body: parsed.body,
          rating: parsed.rating,
          status: 'DRAFT',
          submittedByUserId: req.user.id, // Stage 70 — link for notif on publish
        },
      });
      await audit({
        req,
        actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        action: 'CREATE', entity: 'Testimonial', entityId: t.id,
        after: { selfSubmit: true, paketId: booking.paketId },
      });
    }
    res.redirect(`/saya/bookings/${req.params.id}?testimonial=submitted`);
  }),
);

// ── S321: Jemaah SOS-light help request ──────────────────────
router.post(
  '/api/saya/help-request',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const { submitJemaahHelpRequest } = await import('../services/jemaahHelpRequest.js');
    try {
      const result = await submitJemaahHelpRequest({
        req, actor: { id: req.user.id, email: req.user.email, role: req.user.role },
        userId: req.user.id, message: req.body?.message,
      });
      res.json({
        ok: true,
        bookingNo: result.booking.bookingNo,
        recipients: result.recipients,
        enqueued: result.enqueued,
      });
    } catch (err) {
      const status = err instanceof HttpError ? err.statusCode : 500;
      const code = err instanceof HttpError ? err.code : 'SERVER_ERROR';
      res.status(status).json({ ok: false, code, message: err?.message || 'Gagal' });
    }
  }),
);

// ── S310: Trip feedback (NPS) ────────────────────────────────
router.get(
  '/saya/bookings/:id/feedback',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const booking = await getMyBooking(req.user.id, req.params.id);
    if (!booking) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
    if (booking.status !== 'LUNAS') {
      throw new HttpError(400, 'Feedback hanya bisa diisi setelah booking LUNAS', 'NOT_LUNAS');
    }
    const ret = booking.paket?.returnDate;
    if (!ret || new Date(ret) > new Date()) {
      throw new HttpError(400, 'Feedback hanya bisa diisi setelah paket kembali', 'PAKET_NOT_RETURNED');
    }
    const { getMyTripFeedback } = await import('../services/tripFeedback.js');
    const existing = await getMyTripFeedback({ userId: req.user.id, bookingId: req.params.id });
    res.render('jemaah-feedback', {
      user: req.user, booking, existing,
      flash: { ok: req.query.ok || null, err: req.query.err || null },
    });
  }),
);

router.post(
  '/saya/bookings/:id/feedback',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const { submitTripFeedback } = await import('../services/tripFeedback.js');
    try {
      await submitTripFeedback({
        userId: req.user.id,
        bookingId: req.params.id,
        score: req.body?.score,
        comment: req.body?.comment,
      });
      res.redirect(`/saya/bookings/${req.params.id}/feedback?ok=saved`);
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : (err?.message || 'Gagal menyimpan');
      res.redirect(`/saya/bookings/${req.params.id}/feedback?err=${encodeURIComponent(msg)}`);
    }
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

// Thumbnail variant — serves the cached resize when it exists, falls back
// to the full file otherwise (so pre-thumbnail uploads keep working).
// Same ownership guard as /file via getMyDocFileMeta + wantThumb.
router.get(
  '/saya/documents/:docId/thumb',
  asyncHandler(async (req, res) => {
    const meta = await getMyDocFileMeta({
      userId: req.user.id, docId: req.params.docId, wantThumb: true,
    });
    res.type(meta.mimeType || 'application/octet-stream');
    // Long max-age + immutable: the thumb URL is keyed by docId, and a new
    // upload regenerates a fresh thumb under the SAME key. Stale cache is
    // only a problem if the file changed AND the browser cached aggressively,
    // so add `must-revalidate` so the browser re-checks instead of trusting
    // local cache forever.
    res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
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

// ── Stage 93 — jemaah push subscribe/unsubscribe ─────────────
// Parallel to /api/admin/push but scoped to JEMAAH role only. Same
// PushSubscription table — userId distinguishes admin vs jemaah subs.
router.get(
  '/api/saya/push/config',
  ...requireJemaah,
  asyncHandler(async (_req, res) => {
    const { getPublicKey, getPushMode } = await import('../services/webPush.js');
    res.json({ publicKey: getPublicKey(), mode: getPushMode() });
  }),
);

router.post(
  '/api/saya/push/subscribe',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const { subscribePush } = await import('../services/webPush.js');
    try {
      const row = await subscribePush({
        userId: req.user.id,
        subscription: req.body?.subscription || req.body,
        userAgent: req.headers['user-agent'] || null,
      });
      res.json({ ok: true, id: row.id });
    } catch (err) {
      if (err.code === 'BAD_SUBSCRIPTION') {
        return res.status(400).json({ error: { code: 'BAD_SUBSCRIPTION', message: err.message } });
      }
      throw err;
    }
  }),
);

router.post(
  '/api/saya/push/unsubscribe',
  ...requireJemaah,
  asyncHandler(async (req, res) => {
    const { unsubscribePush } = await import('../services/webPush.js');
    const endpoint = req.body?.endpoint || null;
    const id = req.body?.id || null;
    const r = await unsubscribePush({ endpoint, id, userId: req.user.id });
    res.json(r);
  }),
);

export default router;
