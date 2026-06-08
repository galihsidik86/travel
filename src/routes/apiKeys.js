// Stage 113 — admin CRUD for partner API keys. Same gate as
// outbound webhooks: OWNER+SUPERADMIN only.
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  listApiKeys, createApiKey, updateApiKeyStatus, deleteApiKey, KNOWN_SCOPES,
} from '../services/apiKeys.js';

const router = Router();
router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN'));

function actorFrom(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const keys = await listApiKeys();
    // newToken comes back from POST via query — display once + clear by
    // copying out of the URL after the user has it. Plain query param OK;
    // the token is the partner's responsibility once leaked.
    res.render('admin-api-keys', {
      user: req.user, keys, knownScopes: KNOWN_SCOPES,
      flash: {
        token: req.query.token || null,
        ok: req.query.ok || null,
        err: req.query.err || null,
      },
    });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    try {
      let scopes = req.body?.scopes;
      if (typeof scopes === 'string') scopes = [scopes];
      scopes = scopes || [];
      const created = await createApiKey({
        req, actor: actorFrom(req),
        name: req.body?.name,
        scopes,
        rateLimitPerMin: req.body?.rateLimitPerMin,
      });
      // Surface the token via query — user MUST copy it; we never store
      // the plaintext. Using query keeps the flow stateless; cookies would
      // require a flash store + clean-up.
      res.redirect('/admin/api-keys?token=' + encodeURIComponent(created.token));
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect('/admin/api-keys?err=' + encodeURIComponent(err.message));
      }
      throw err;
    }
  }),
);

router.post(
  '/:id/status',
  asyncHandler(async (req, res) => {
    try {
      await updateApiKeyStatus({
        req, actor: actorFrom(req),
        id: req.params.id, status: req.body?.status,
      });
      res.redirect('/admin/api-keys?ok=status');
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect('/admin/api-keys?err=' + encodeURIComponent(err.message));
      }
      throw err;
    }
  }),
);

router.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    try {
      await deleteApiKey({ req, actor: actorFrom(req), id: req.params.id });
      res.redirect('/admin/api-keys?ok=deleted');
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect('/admin/api-keys?err=' + encodeURIComponent(err.message));
      }
      throw err;
    }
  }),
);

export default router;
