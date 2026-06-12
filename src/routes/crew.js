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
// Stage 148 — reuse the role-agnostic helpers from jemaahPortal.
import {
  listMyNotifications, listMyNotificationsPaginated,
  countUnreadForUser, markAllReadForUser,
} from '../services/jemaahPortal.js';

const router = Router();

// All crew routes require MUTHAWWIF — other roles 403 (the auth middleware
// itself returns 401 → redirect to /login for unauth'd HTML requests).
router.use(requireAuth, requireRole('MUTHAWWIF'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    // Stage 207 — crew sees their own open Tasks (S91) where
    // assigneeEmail = their email. Best-effort: failure to load
    // tasks shouldn't 500 the dashboard.
    const { getMyOpenTasks } = await import('../services/tasks.js');
    const [paketList, myIncidents, unreadCount, myTasks] = await Promise.all([
      listAssignedPaket(req.user.id),
      listMyIncidents(req.user.id, { limit: 10 }),
      // Stage 148 — unread badge on crew topbar
      countUnreadForUser(req.user.id).catch(() => 0),
      getMyOpenTasks({ assigneeEmail: req.user.email })
        .catch((err) => { console.warn('[crew] tasks failed:', err?.message || err); return null; }),
    ]);
    res.render('crew-portal', { user: req.user, paketList, myIncidents, unreadCount, myTasks });
  }),
);

// Stage 148 — crew inbox. Same shape as /agen and /saya: render then
// mark-read in one pass.
router.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    // Stage 181 — paginated history.
    const page = parseInt(req.query.page, 10) || 1;
    const { rows: notifications, total, pagination } =
      await listMyNotificationsPaginated(req.user.id, { page });
    await markAllReadForUser(req.user.id);
    res.render('crew-notifications', {
      user: req.user, notifications, total, pagination,
    });
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
    // Stage 187 — load this crew's own notes per jemaah so the manifest
    // shows the existing body in the inline edit textarea.
    const { db } = await import('../lib/db.js');
    const myNotes = await db.crewJemaahNote.findMany({
      where: { paketId: manifest.id, crewUserId: req.user.id },
      select: { jemaahId: true, body: true, updatedAt: true },
    });
    const myNotesByJemaah = Object.fromEntries(myNotes.map((n) => [n.jemaahId, n]));
    // Stage 218 — surface admin-posted paket announcements (S192) to crew.
    // Crew need the same heads-up jemaah get ("visa delayed", "pickup time
    // moved"). Best-effort — a query failure dims the panel but the
    // manifest still renders.
    let announcements = [];
    try {
      const { listActiveAnnouncements } = await import('../services/paketAnnouncements.js');
      announcements = await listActiveAnnouncements({ paketId: manifest.id });
    } catch (err) {
      console.warn('[crew-manifest] announcements load failed:', err?.message || err);
    }
    res.render('crew-manifest', { user: req.user, paket: manifest, myNotesByJemaah, announcements });
  }),
);

// Stage 187 — POST per-jemaah note. Empty body deletes the existing
// row; non-empty upserts the (paket, jemaah, crew) triple.
router.post(
  '/paket/:slug/note',
  asyncHandler(async (req, res) => {
    const { saveCrewJemaahNote } = await import('../services/crewJemaahNotes.js');
    try {
      await saveCrewJemaahNote({
        userId: req.user.id, paketSlug: req.params.slug,
        jemaahId: req.body?.jemaahId, body: req.body?.body,
      });
      res.redirect(`/crew/paket/${encodeURIComponent(req.params.slug)}?ok=note_saved`);
    } catch (err) {
      const msg = err?.message || 'Gagal simpan';
      res.redirect(`/crew/paket/${encodeURIComponent(req.params.slug)}?err=${encodeURIComponent(msg)}`);
    }
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
