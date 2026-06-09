import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  listAudits, getAuditActivity, getAuditById, exportAuditCsv,
  ENTITIES, ACTIONS,
} from '../services/auditLog.js';
import { audit } from '../lib/audit.js';

const router = Router();

router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = {
      entity: req.query.entity || 'ALL',
      action: req.query.action || 'ALL',
      actorEmail: (req.query.actorEmail || '').trim(),
      from: req.query.from || '',
      to: req.query.to || '',
      page: req.query.page || 1,
    };
    const [result, activity] = await Promise.all([
      listAudits(filters),
      getAuditActivity(filters),
    ]);
    res.render('audit-list', {
      user: req.user, ...result,
      activity,
      filters, ENTITIES, ACTIONS,
    });
  }),
);

// Stage 138 — streaming CSV export for compliance / investigator asks.
// 7-day default window, 90-day cap, 50k row hard ceiling. The export
// itself writes one audit row (action=EXPORT, entity=AuditLog) so the
// fact-of-export is itself audited — investigator never disputes
// "did anyone pull the log?".
router.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const filenameStamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_${filenameStamp}.csv"`);
    const result = await exportAuditCsv({
      entity: req.query.entity || null,
      action: req.query.action || null,
      actorEmail: (req.query.actorEmail || '').trim() || null,
      from: req.query.from || null,
      to: req.query.to || null,
      writeStream: res,
    });
    res.end();

    // Self-audit fire-and-forget; the bytes have already left the wire,
    // a failed audit insert mustn't crash the response.
    audit({
      req,
      actor: { id: req.user.id, email: req.user.email, role: req.user.role },
      action: 'EXPORT', entity: 'AuditLog', entityId: 'csv',
      after: {
        rowsWritten: result.rowsWritten,
        capped: result.capped,
        rangeFrom: result.range.from.toISOString(),
        rangeTo: result.range.to.toISOString(),
        rangeDays: result.range.days,
        filters: {
          entity: req.query.entity || null,
          action: req.query.action || null,
          actorEmail: req.query.actorEmail || null,
        },
      },
    }).catch((err) => console.warn('[audit-export] self-audit failed:', err?.message || err));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const entry = await getAuditById(req.params.id);
    if (!entry) throw new HttpError(404, 'Audit log tidak ditemukan', 'AUDIT_NOT_FOUND');
    res.render('audit-detail', { user: req.user, entry });
  }),
);

export default router;
