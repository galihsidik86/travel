import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { db } from '../lib/db.js';
import {
  CreatePayoutSchema, createPayout, listPayouts, getPayoutById, getPayoutSlip, META,
} from '../services/payouts.js';

const router = Router();

router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN', 'MANAJER_OPS'));

function actorFrom(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { payouts, outstanding } = await listPayouts();
    res.render('payouts-list', { user: req.user, payouts, outstanding });
  }),
);

router.get(
  '/new',
  asyncHandler(async (req, res) => {
    const { outstanding } = await listPayouts();
    // Stage 166 — pre-fill from the agent's stored payout details when
    // ?agentId=<id> is passed (from the outstanding list "Bayar" CTA).
    // Empty when no agent picked yet — form picks them mid-flow.
    let prefill = null;
    const wantAgentId = (req.query.agentId || '').toString();
    if (wantAgentId) {
      const a = await db.agentProfile.findUnique({
        where: { id: wantAgentId },
        select: {
          id: true, slug: true, displayName: true,
          preferredPayoutMethod: true, bankName: true,
          bankAccountNumber: true, bankAccountName: true,
        },
      });
      if (a) prefill = a;
    }
    const method = prefill?.preferredPayoutMethod || 'TRANSFER';
    // Build a "Bank: BCA · No: 1234567 · Nama: Ahmad" reference snippet
    // so KASIR has the receipient info inline without leaving the form.
    let reference = '';
    if (prefill?.bankAccountNumber) {
      const bits = [];
      if (prefill.bankName) bits.push(prefill.bankName);
      bits.push(`No ${prefill.bankAccountNumber}`);
      if (prefill.bankAccountName) bits.push(`a/n ${prefill.bankAccountName}`);
      reference = bits.join(' · ');
    }
    res.render('payouts-form', {
      user: req.user, outstanding, META,
      error: null,
      values: { agentId: prefill?.id || '', method, reference, notes: '' },
      prefill,
    });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    try {
      const data = CreatePayoutSchema.parse(req.body);
      const result = await createPayout({ req, actor: actorFrom(req), ...data });
      res.redirect(`/admin/payouts/${result.payout.id}?ok=created`);
    } catch (err) {
      const { outstanding } = await listPayouts();
      const msg = err.issues?.[0]?.message || err.message || 'Gagal proses payout';
      return res.status(400).render('payouts-form', {
        user: req.user, outstanding, META,
        error: msg, values: req.body || {},
      });
    }
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const payout = await getPayoutById(req.params.id);
    if (!payout) throw new HttpError(404, 'Payout tidak ditemukan', 'PAYOUT_NOT_FOUND');
    res.render('payouts-detail', { user: req.user, p: payout });
  }),
);

// Stage 21 — printable slip for accounting / agen handover.
router.get(
  '/:id/print',
  asyncHandler(async (req, res) => {
    const data = await getPayoutSlip(req.params.id);
    res.render('payout-slip', { user: req.user, ...data });
  }),
);

export default router;
