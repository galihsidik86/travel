// JSON CRUD for PaketHotel + PaketDay (nested under a Paket).
// Mounted under /api/paket so errors flow through global JSON error handler.
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  addHotel, updateHotel, deleteHotel,
  addDay, updateDay, deleteDay,
  addRoom, updateRoom, deleteRoom,
  clonePaket,
} from '../services/paketAdmin.js';
import { assignCrewToPaket, unassignCrewFromPaket } from '../services/crewPortal.js';
import { setPaketOverride, clearPaketOverride } from '../services/agentPaketKomisi.js';
import { addCostLine, updateCostLine, deleteCostLine } from '../services/paketCostLines.js';
import { db } from '../lib/db.js';
import { HttpError } from '../middleware/error.js';

const router = Router({ mergeParams: true });

router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

function actorFrom(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

// ── Hotels ───────────────────────────────────────────────────
router.post(
  '/:slug/hotels',
  asyncHandler(async (req, res) => {
    const hotel = await addHotel({ req, actor: actorFrom(req), paketSlug: req.params.slug, input: req.body });
    res.status(201).json({ hotel });
  }),
);
router.patch(
  '/:slug/hotels/:hotelId',
  asyncHandler(async (req, res) => {
    const hotel = await updateHotel({
      req, actor: actorFrom(req),
      paketSlug: req.params.slug, hotelId: req.params.hotelId,
      input: req.body,
    });
    res.json({ hotel });
  }),
);
router.delete(
  '/:slug/hotels/:hotelId',
  asyncHandler(async (req, res) => {
    await deleteHotel({
      req, actor: actorFrom(req),
      paketSlug: req.params.slug, hotelId: req.params.hotelId,
    });
    res.json({ ok: true });
  }),
);

// ── Rooms ────────────────────────────────────────────────────
router.post(
  '/:slug/rooms',
  asyncHandler(async (req, res) => {
    const room = await addRoom({ req, actor: actorFrom(req), paketSlug: req.params.slug, input: req.body });
    res.status(201).json({ room });
  }),
);
router.patch(
  '/:slug/rooms/:roomId',
  asyncHandler(async (req, res) => {
    const room = await updateRoom({
      req, actor: actorFrom(req),
      paketSlug: req.params.slug, roomId: req.params.roomId,
      input: req.body,
    });
    res.json({ room });
  }),
);
router.delete(
  '/:slug/rooms/:roomId',
  asyncHandler(async (req, res) => {
    await deleteRoom({
      req, actor: actorFrom(req),
      paketSlug: req.params.slug, roomId: req.params.roomId,
    });
    res.json({ ok: true });
  }),
);

// ── Days ─────────────────────────────────────────────────────
router.post(
  '/:slug/days',
  asyncHandler(async (req, res) => {
    const day = await addDay({ req, actor: actorFrom(req), paketSlug: req.params.slug, input: req.body });
    res.status(201).json({ day });
  }),
);
router.patch(
  '/:slug/days/:dayId',
  asyncHandler(async (req, res) => {
    const day = await updateDay({
      req, actor: actorFrom(req),
      paketSlug: req.params.slug, dayId: req.params.dayId,
      input: req.body,
    });
    res.json({ day });
  }),
);
router.delete(
  '/:slug/days/:dayId',
  asyncHandler(async (req, res) => {
    await deleteDay({
      req, actor: actorFrom(req),
      paketSlug: req.params.slug, dayId: req.params.dayId,
    });
    res.json({ ok: true });
  }),
);

// ── Crew (5oo) ───────────────────────────────────────────────
router.post(
  '/:slug/crew',
  asyncHandler(async (req, res) => {
    const userId = req.body?.userId;
    if (!userId) {
      return res.status(400).json({ error: { code: 'USER_ID_REQUIRED', message: 'userId wajib' } });
    }
    const row = await assignCrewToPaket({
      req, actor: actorFrom(req),
      paketSlug: req.params.slug, userId,
    });
    res.status(201).json({ assignment: row });
  }),
);
router.delete(
  '/:slug/crew/:userId',
  asyncHandler(async (req, res) => {
    await unassignCrewFromPaket({
      req, actor: actorFrom(req),
      paketSlug: req.params.slug, userId: req.params.userId,
    });
    res.json({ ok: true });
  }),
);

// ── Clone paket (stage 18) — copy hotels/days/prices into fresh DRAFT ──
router.post(
  '/:slug/clone',
  asyncHandler(async (req, res) => {
    const cloned = await clonePaket({
      req, actor: actorFrom(req),
      sourceSlug: req.params.slug,
      input: {
        newSlug: req.body?.newSlug,
        newTitle: req.body?.newTitle,
        newDepartureDate: req.body?.newDepartureDate,
        newReturnDate: req.body?.newReturnDate,
        includeAgentOverrides: req.body?.includeAgentOverrides,
      },
    });
    res.status(201).json({ paket: { slug: cloned.slug, title: cloned.title, status: cloned.status } });
  }),
);

// ── Per-agent komisi overrides (stage 14) ────────────────────
// PUT semantics: idempotent upsert keyed on (agentId, paketSlug).
router.put(
  '/:slug/komisi-overrides',
  asyncHandler(async (req, res) => {
    const row = await setPaketOverride({
      req, actor: actorFrom(req),
      paketSlug: req.params.slug,
      input: { agentId: req.body?.agentId, rate: req.body?.rate },
    });
    res.json({ override: row });
  }),
);
router.delete(
  '/:slug/komisi-overrides/:agentId',
  asyncHandler(async (req, res) => {
    await clearPaketOverride({
      req, actor: actorFrom(req),
      paketSlug: req.params.slug, agentId: req.params.agentId,
    });
    res.json({ ok: true });
  }),
);

// ── Cost lines (Stage 92) ────────────────────────────────────
async function paketIdFromSlug(slug) {
  const p = await db.paket.findUnique({ where: { slug }, select: { id: true } });
  if (!p) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
  return p.id;
}

router.post(
  '/:slug/cost-lines',
  asyncHandler(async (req, res) => {
    const paketId = await paketIdFromSlug(req.params.slug);
    const result = await addCostLine({
      req, actor: actorFrom(req),
      paketId,
      category: req.body?.category,
      amountIdr: req.body?.amountIdr,
      vendorNote: req.body?.vendorNote,
    });
    res.status(201).json(result);
  }),
);

router.patch(
  '/:slug/cost-lines/:id',
  asyncHandler(async (req, res) => {
    const result = await updateCostLine({
      req, actor: actorFrom(req),
      id: req.params.id,
      category: req.body?.category,
      amountIdr: req.body?.amountIdr,
      vendorNote: req.body?.vendorNote,
    });
    res.json(result);
  }),
);

router.delete(
  '/:slug/cost-lines/:id',
  asyncHandler(async (req, res) => {
    const result = await deleteCostLine({ req, actor: actorFrom(req), id: req.params.id });
    res.json(result);
  }),
);

// ── Stage 190: FAQ CRUD ──────────────────────────────────────
router.post(
  '/:slug/faqs',
  asyncHandler(async (req, res) => {
    const { createFaq } = await import('../services/paketFaqs.js');
    // Resolve paketId from slug
    const paket = await db.paket.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
    const faq = await createFaq({
      req, actor: actorFrom(req), paketId: paket.id, input: req.body,
    });
    res.status(201).json({ faq });
  }),
);
router.patch(
  '/:slug/faqs/:id',
  asyncHandler(async (req, res) => {
    const { updateFaq } = await import('../services/paketFaqs.js');
    const faq = await updateFaq({
      req, actor: actorFrom(req), id: req.params.id, input: req.body,
    });
    res.json({ faq });
  }),
);
router.delete(
  '/:slug/faqs/:id',
  asyncHandler(async (req, res) => {
    const { deleteFaq } = await import('../services/paketFaqs.js');
    const result = await deleteFaq({
      req, actor: actorFrom(req), id: req.params.id,
    });
    res.json(result);
  }),
);

// ── Stage 192: Announcements CRUD ────────────────────────────
router.post(
  '/:slug/announcements',
  asyncHandler(async (req, res) => {
    const { createAnnouncement } = await import('../services/paketAnnouncements.js');
    const paket = await db.paket.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
    if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
    const row = await createAnnouncement({
      req, actor: actorFrom(req), paketId: paket.id, input: req.body,
    });
    res.status(201).json({ announcement: row });
  }),
);
router.patch(
  '/:slug/announcements/:id',
  asyncHandler(async (req, res) => {
    const { updateAnnouncement } = await import('../services/paketAnnouncements.js');
    const row = await updateAnnouncement({
      req, actor: actorFrom(req), id: req.params.id, input: req.body,
    });
    res.json({ announcement: row });
  }),
);
router.delete(
  '/:slug/announcements/:id',
  asyncHandler(async (req, res) => {
    const { deleteAnnouncement } = await import('../services/paketAnnouncements.js');
    const result = await deleteAnnouncement({
      req, actor: actorFrom(req), id: req.params.id,
    });
    res.json(result);
  }),
);

export default router;
