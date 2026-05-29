// 5oo: muthawwif (crew) portal routes.
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  listAssignedPaket, getAssignedManifest, buildCrewManifestCsv,
  listAttendanceDays, getAttendanceGrid, setAttendanceMark,
} from '../services/crewPortal.js';
import { createIncident, listMyIncidents } from '../services/incidents.js';

const router = Router();

// All crew routes require MUTHAWWIF — other roles 403 (the auth middleware
// itself returns 401 → redirect to /login for unauth'd HTML requests).
router.use(requireAuth, requireRole('MUTHAWWIF'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [paketList, myIncidents] = await Promise.all([
      listAssignedPaket(req.user.id),
      listMyIncidents(req.user.id, { limit: 10 }),
    ]);
    res.render('crew-portal', { user: req.user, paketList, myIncidents });
  }),
);

// SOS / incident report. Form-encoded POST so the static <form> works without
// JS too. Returns redirect with ?sos=sent for the success banner; JSON
// caller can read the resulting Location header for the page redirect.
router.post(
  '/sos',
  asyncHandler(async (req, res) => {
    const incident = await createIncident({
      req,
      crewUser: req.user,
      input: {
        type: req.body?.type || 'SOS',
        paketSlug: req.body?.paketSlug || null,
        message: req.body?.message || null,
        locationLabel: req.body?.locationLabel || null,
      },
    });
    res.redirect(`/crew?sos=sent&id=${encodeURIComponent(incident.id)}`);
  }),
);

router.get(
  '/paket/:slug',
  asyncHandler(async (req, res) => {
    const manifest = await getAssignedManifest({ userId: req.user.id, slug: req.params.slug });
    if (!manifest) throw new HttpError(404, 'Paket tidak ditemukan atau Anda tidak di-assign', 'NOT_ASSIGNED');
    res.render('crew-manifest', { user: req.user, paket: manifest });
  }),
);

// 5ss: offline-friendly CSV export of an assigned paket's manifest
router.get(
  '/paket/:slug/export.csv',
  asyncHandler(async (req, res) => {
    const out = await buildCrewManifestCsv({ userId: req.user.id, slug: req.params.slug });
    if (!out) throw new HttpError(404, 'Paket tidak ditemukan atau Anda tidak di-assign', 'NOT_ASSIGNED');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.csv);
  }),
);

// ── 5ww: attendance per-day ──────────────────────────────────
router.get(
  '/paket/:slug/attendance',
  asyncHandler(async (req, res) => {
    const data = await listAttendanceDays({ userId: req.user.id, slug: req.params.slug });
    if (!data) throw new HttpError(404, 'Paket tidak ditemukan atau Anda tidak di-assign', 'NOT_ASSIGNED');
    res.render('crew-attendance-overview', { user: req.user, paket: data });
  }),
);

router.get(
  '/paket/:slug/attendance/:dayId',
  asyncHandler(async (req, res) => {
    const data = await getAttendanceGrid({
      userId: req.user.id, slug: req.params.slug, dayId: req.params.dayId,
    });
    if (!data) throw new HttpError(404, 'Hari tidak ditemukan', 'NOT_FOUND');
    res.render('crew-attendance-day', { user: req.user, ...data });
  }),
);

router.post(
  '/paket/:slug/attendance/:dayId/:bookingId',
  asyncHandler(async (req, res) => {
    await setAttendanceMark({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      userId: req.user.id,
      slug: req.params.slug, dayId: req.params.dayId, bookingId: req.params.bookingId,
      present: req.body?.present,
      notes: req.body?.notes,
    });
    res.redirect(`/crew/paket/${encodeURIComponent(req.params.slug)}/attendance/${req.params.dayId}?ok=saved`);
  }),
);

export default router;
