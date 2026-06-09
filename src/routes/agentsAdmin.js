// Stage 151 — admin overrides for agent-side artifacts.
// Currently: re-generate a monthly komisi statement when late
// adjustments make the original wrong. Mount under /admin/agents.
import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { db } from '../lib/db.js';
import { regenerateAgentStatement } from '../services/komisiStatement.js';

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

    const result = await regenerateAgentStatement({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      agentId: agent.id,
      periodYM,
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

export default router;
