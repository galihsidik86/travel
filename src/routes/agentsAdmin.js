// Stage 151 — admin overrides for agent-side artifacts.
// Currently: re-generate a monthly komisi statement when late
// adjustments make the original wrong. Mount under /admin/agents.
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { db } from '../lib/db.js';
import { regenerateAgentStatement, renderPaketScopedStatementBuffer } from '../services/komisiStatement.js';

const router = Router();
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN'));

/**
 * Regenerate a statement for `(agentSlug, periodYM)`. POST body or
 * query may carry `periodYM` (YYYY-MM); when omitted the agent's
 * latest existing statement is regenerated.
 *
 * Redirect-after-POST so the admin lands back on /admin/users (where
 * the trigger button lives) with a flash.
 */
router.post(
  '/:slug/statements/regenerate',
  asyncHandler(async (req, res) => {
    const agent = await db.agentProfile.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, slug: true },
    });
    if (!agent) throw new HttpError(404, 'Agen tidak ditemukan', 'AGENT_NOT_FOUND');

    let periodYM = (req.body?.periodYM || req.query?.periodYM || '').toString().trim();
    if (!periodYM) {
      // Default to the agent's most-recent existing statement when caller
      // didn't specify. Admin usually wants to fix the latest one.
      const latest = await db.komisiStatement.findFirst({
        where: { agentId: agent.id },
        orderBy: { periodYM: 'desc' },
        select: { periodYM: true },
      });
      if (!latest) {
        throw new HttpError(409,
          'Agen ini belum punya statement — jalankan generate-komisi-statements dulu (atau backfill).',
          'NO_EXISTING_STATEMENT');
      }
      periodYM = latest.periodYM;
    }

    // S156 — admin note flows through. Empty textarea clears the prior
    // note; an explicit `undefined` (field omitted from request) would
    // preserve it via the service-side fallback, but a real form
    // submission always includes the empty string, so admin clears by
    // leaving the box empty.
    const adminNote = req.body?.adminNote ?? null;
    const result = await regenerateAgentStatement({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      agentId: agent.id,
      periodYM,
      adminNote,
    });

    const flashParams = new URLSearchParams({
      ok: 'statement_regenerated',
      agentSlug: agent.slug,
      periodYM,
      // Surface prior totals in the flash so admin sees the diff inline
      ...(result.prior ? {
        priorEarnedIdr: String(result.prior.totalEarnedIdr),
        priorPaidIdr: String(result.prior.totalPaidIdr),
      } : {}),
    });
    res.redirect('/admin/users?' + flashParams.toString());
  }),
);

/**
 * Stage 159 — transient per-paket statement for dispute resolution.
 * Streams PDF inline; doesn't persist a KomisiStatement row + doesn't
 * fire a notif. Admin sends the link to the agent during a back-and-
 * forth like "I think you under-counted my Ramadhan-2026 komisi —
 * show me only that paket's lines".
 *
 * Both `periodYM` and `paketSlug` are query params so the URL is
 * shareable. Validates strict format / existence upstream — opaque
 * errors aren't useful to a stressed admin.
 */
router.get(
  '/:slug/statement-paket.pdf',
  asyncHandler(async (req, res) => {
    const agent = await db.agentProfile.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, slug: true },
    });
    if (!agent) throw new HttpError(404, 'Agen tidak ditemukan', 'AGENT_NOT_FOUND');
    const periodYM = (req.query?.periodYM || '').toString().trim();
    const paketSlug = (req.query?.paketSlug || '').toString().trim();
    if (!periodYM) throw new HttpError(400, 'periodYM query param wajib (YYYY-MM)', 'BAD_PERIOD');
    if (!paketSlug) throw new HttpError(400, 'paketSlug query param wajib', 'BAD_PAKET');
    const paket = await db.paket.findUnique({
      where: { slug: paketSlug }, select: { id: true, slug: true },
    });
    if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');

    const { buffer } = await renderPaketScopedStatementBuffer({
      agentId: agent.id, periodYM, paketId: paket.id,
    });
    const filename = `komisi_${agent.slug}_${periodYM}_${paket.slug}.pdf`
      .replace(/[^A-Za-z0-9_.-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(buffer);
  }),
);

export default router;
