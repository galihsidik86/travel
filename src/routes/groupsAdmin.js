// Stage 261 — per-group detail page + CSV. Surfaces every member of a
// Booking.groupKey cluster (S257) together with combined money totals,
// and lets admin set the S260 label/notes.
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { getBookingGroup, setGroupLabel, normaliseGroupKey, bulkCancelGroup } from '../services/bookingGroup.js';
import { CANCEL_REASON_CODES } from '../services/bookingAdmin.js';

const router = Router();

// Same RBAC as the rest of the booking admin surface.
const VIEW_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR'];
const EDIT_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS'];

router.use(requireAuth);

function actorFrom(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

// ── GET /admin/groups/:key ─────────────────────────────────────
router.get(
  '/:key',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const key = normaliseGroupKey(req.params.key);
    if (!key) throw new HttpError(400, 'Format groupKey tidak valid', 'BAD_GROUP_KEY');
    const group = await getBookingGroup(key);
    if (!group) throw new HttpError(404, 'Grup tidak ditemukan', 'GROUP_NOT_FOUND');
    // Compute combined money totals + status rollup over the members.
    // Active = NOT IN (CANCELLED, REFUNDED). Same convention as manifest.
    const totals = group.members.reduce((acc, m) => {
      const total = Number(m.totalAmount?.toString?.() ?? m.totalAmount) || 0;
      const paid = Number(m.paidAmount?.toString?.() ?? m.paidAmount) || 0;
      const isActive = m.status !== 'CANCELLED' && m.status !== 'REFUNDED';
      acc.memberCount += 1;
      acc.activeCount += isActive ? 1 : 0;
      acc.paxCount += m.paxCount || 0;
      acc.totalAmountIdr += total;
      acc.paidAmountIdr += paid;
      acc.balanceIdr += total - paid;
      acc.byStatus[m.status] = (acc.byStatus[m.status] || 0) + 1;
      return acc;
    }, {
      memberCount: 0, activeCount: 0, paxCount: 0,
      totalAmountIdr: 0, paidAmountIdr: 0, balanceIdr: 0,
      byStatus: {},
    });
    const canEdit = EDIT_ROLES.includes(req.user.role);
    const canCancel = EDIT_ROLES.includes(req.user.role);
    res.render('group-detail', {
      user: req.user, group, totals, canEdit, canCancel,
      cancelReasonCodes: CANCEL_REASON_CODES,
      ok: req.query.ok || null, err: req.query.err || null,
    });
  }),
);

// ── POST /admin/groups/:key/label ──────────────────────────────
router.post(
  '/:key/label',
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const key = normaliseGroupKey(req.params.key);
    if (!key) {
      return res.redirect(`/admin/bookings?err=${encodeURIComponent('Format groupKey tidak valid')}`);
    }
    try {
      await setGroupLabel({
        req, actor: actorFrom(req),
        groupKey: key,
        // label/notes are always present from the form (textarea/input
        // always submit, possibly empty), so the three-state semantics
        // collapse to "empty clears, value sets".
        label: req.body?.label ?? '',
        notes: req.body?.notes ?? '',
      });
      res.redirect(`/admin/groups/${encodeURIComponent(key)}?ok=label`);
    } catch (err) {
      const msg = err?.message || 'Gagal simpan label';
      res.redirect(`/admin/groups/${encodeURIComponent(key)}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// ── POST /admin/groups/:key/bulk-cancel ────────────────────────
// Stage 262 — cancel every active member with one shared reason.
router.post(
  '/:key/bulk-cancel',
  requireRole(...EDIT_ROLES),
  asyncHandler(async (req, res) => {
    const key = normaliseGroupKey(req.params.key);
    if (!key) {
      return res.redirect(`/admin/bookings?err=${encodeURIComponent('Format groupKey tidak valid')}`);
    }
    try {
      const result = await bulkCancelGroup({
        req, actor: actorFrom(req),
        groupKey: key,
        reason: req.body?.reason || '',
        reasonCode: req.body?.reasonCode || null,
      });
      const flash = `bulk_cancel:${result.cancelled.length}/${result.requested}` +
        (result.failed.length > 0 ? `:failed=${result.failed.length}` : '');
      res.redirect(`/admin/groups/${encodeURIComponent(key)}?ok=${encodeURIComponent(flash)}`);
    } catch (err) {
      const msg = err?.message || 'Gagal bulk cancel';
      res.redirect(`/admin/groups/${encodeURIComponent(key)}?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// ── GET /admin/groups/:key/export.csv ──────────────────────────
router.get(
  '/:key/export.csv',
  requireRole(...VIEW_ROLES),
  asyncHandler(async (req, res) => {
    const key = normaliseGroupKey(req.params.key);
    if (!key) throw new HttpError(400, 'Format groupKey tidak valid', 'BAD_GROUP_KEY');
    const group = await getBookingGroup(key);
    if (!group) throw new HttpError(404, 'Grup tidak ditemukan', 'GROUP_NOT_FOUND');
    const { buildGroupCsv } = await import('../services/bookingGroupCsv.js');
    const csv = buildGroupCsv(group);
    const safeKey = key.replace(/[^A-Z0-9-]/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="group_${safeKey}.csv"`);
    res.send(csv);
  }),
);

export default router;
