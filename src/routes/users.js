import { Router } from 'express';
import { ZodError } from 'zod';

import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  CreateUserSchema, UpdateUserSchema, PasswordSchema,
  listUsers, getUserById, createUser, updateUser, setPassword,
  suspendUser, reactivateUser, restoreUser, META,
} from '../services/userAdmin.js';
import {
  listShortcodes, createShortcode, deleteShortcode, listStaffForShortcode,
} from '../services/mentionShortcodes.js';

const router = Router();

router.use(requireAuth, requireRole('OWNER', 'SUPERADMIN'));

function actorFrom(req) {
  return { id: req.user.id, email: req.user.email, role: req.user.role };
}

function zodToErrors(err) {
  const out = {};
  for (const issue of err.issues) {
    const p = issue.path.join('.');
    if (!(p in out)) out[p] = issue.message;
  }
  return out;
}

// Empty scaffold for the create form
function emptyUser() {
  return {
    email: '', fullName: '', phone: '',
    role: 'JEMAAH', status: 'ACTIVE',
    slug: '', displayName: '', whatsapp: '', bio: '', tier: '',
    komisiRateOverridePct: '',
    department: '', position: '',
    languages: '', experience: '',
    // Stage 73 — crew public profile defaults
    crewSlug: '', crewTitlePrefix: '', crewBio: '', crewPhotoUrl: '',
    // Stage 74 — agent public profile defaults
    agentPhotoUrl: '', igHandle: '',
  };
}

function bodyToForm(body) { return { ...emptyUser(), ...body }; }

// ── GET /admin/users (list) ──────────────────────────────────
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const search = (req.query.q || '').trim();
    const role = req.query.role || 'ALL';
    const status = req.query.status || 'ALL';
    // Stage 104 — deleted filter: ACTIVE (default) / DELETED / ALL.
    const deleted = (req.query.deleted || 'ACTIVE').toUpperCase();
    const validDeleted = ['ACTIVE', 'DELETED', 'ALL'].includes(deleted) ? deleted : 'ACTIVE';
    const users = await listUsers({ search, role, status, deleted: validDeleted });
    res.render('users-list', {
      user: req.user, users, search, role, status, META, deleted: validDeleted,
      // Stage 151 — flash from /admin/agents/:slug/statements/regenerate
      flash: {
        ok: req.query.ok || null,
        agentSlug: req.query.agentSlug || null,
        periodYM: req.query.periodYM || null,
        priorEarnedIdr: req.query.priorEarnedIdr || null,
        priorPaidIdr: req.query.priorPaidIdr || null,
      },
    });
  }),
);

// ── POST /admin/users/:id/restore (S104) ─────────────────────
router.post(
  '/:id/restore',
  asyncHandler(async (req, res) => {
    await restoreUser({ req, actor: actorFrom(req), userId: req.params.id });
    res.redirect('/admin/users?deleted=ACTIVE&ok=restored');
  }),
);

// ── GET /admin/users/shortcodes (S88) ────────────────────────
// List + create + delete mention shortcuts. OWNER+SUPERADMIN gate
// inherited from router.use above.
router.get(
  '/shortcodes',
  asyncHandler(async (req, res) => {
    const [shortcodes, staff] = await Promise.all([
      listShortcodes(),
      listStaffForShortcode(),
    ]);
    res.render('users-shortcodes', {
      user: req.user, shortcodes, staff,
      flash: { created: req.query.created || null, deleted: req.query.deleted || null, err: req.query.err || null },
    });
  }),
);

router.post(
  '/shortcodes',
  asyncHandler(async (req, res) => {
    try {
      await createShortcode({
        req, actor: actorFrom(req),
        code: req.body?.code, userId: req.body?.userId,
      });
      res.redirect('/admin/users/shortcodes?created=ok');
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect('/admin/users/shortcodes?err=' + encodeURIComponent(err.message));
      }
      throw err;
    }
  }),
);

router.post(
  '/shortcodes/:id/delete',
  asyncHandler(async (req, res) => {
    try {
      await deleteShortcode({ req, actor: actorFrom(req), id: req.params.id });
      res.redirect('/admin/users/shortcodes?deleted=ok');
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect('/admin/users/shortcodes?err=' + encodeURIComponent(err.message));
      }
      throw err;
    }
  }),
);

// ── GET /admin/users/new (create form) ───────────────────────
router.get(
  '/new',
  (req, res) => {
    res.render('users-form', {
      user: req.user, mode: 'new', target: emptyUser(),
      errors: {}, formError: null, META,
    });
  },
);

// ── POST /admin/users (create) ───────────────────────────────
router.post(
  '/',
  asyncHandler(async (req, res) => {
    try {
      const input = CreateUserSchema.parse(req.body);
      const created = await createUser({ req, actor: actorFrom(req), input });
      res.redirect(`/admin/users/${created.id}/edit?ok=created`);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).render('users-form', {
          user: req.user, mode: 'new', target: bodyToForm(req.body),
          errors: zodToErrors(err), formError: 'Periksa kembali isian form.', META,
        });
      }
      if (err instanceof HttpError && (err.status === 409 || err.status === 400 || err.status === 403)) {
        return res.status(err.status).render('users-form', {
          user: req.user, mode: 'new', target: bodyToForm(req.body),
          errors: { _: err.message }, formError: err.message, META,
        });
      }
      throw err;
    }
  }),
);

// ── GET /admin/users/:id/edit ────────────────────────────────
router.get(
  '/:id/edit',
  asyncHandler(async (req, res) => {
    const target = await getUserById(req.params.id);
    if (!target || target.deletedAt) throw new HttpError(404, 'User tidak ditemukan', 'USER_NOT_FOUND');
    const flat = {
      id: target.id,
      email: target.email,
      fullName: target.fullName,
      phone: target.phone || '',
      role: target.role,
      status: target.status,
      lastLoginAt: target.lastLoginAt,
      createdAt: target.createdAt,
      slug: target.agent?.slug || '',
      displayName: target.agent?.displayName || '',
      whatsapp: target.agent?.whatsapp || '',
      bio: target.agent?.bio || '',
      tier: target.agent?.tier || '',
      // Decimal(5,4) → percentage display
      komisiRateOverridePct: target.agent?.komisiRateOverride != null
        ? (Number(target.agent.komisiRateOverride.toString?.() ?? target.agent.komisiRateOverride) * 100)
            .toFixed(2).replace(/\.?0+$/, '')
        : '',
      department: target.staff?.department || '',
      position: target.staff?.position || '',
      languages: target.crew?.languages || '',
      experience: target.crew?.experience ?? '',
      // Stage 73 — crew public profile fields
      crewSlug: target.crew?.slug || '',
      crewTitlePrefix: target.crew?.titlePrefix || '',
      crewBio: target.crew?.bio || '',
      crewPhotoUrl: target.crew?.photoUrl || '',
      // Stage 74 — agent public profile fields
      agentPhotoUrl: target.agent?.photoUrl || '',
      igHandle: target.agent?.igHandle || '',
    };
    res.render('users-form', {
      user: req.user, mode: 'edit', target: flat,
      errors: {}, formError: null, META,
    });
  }),
);

// ── POST /admin/users/:id (update) ───────────────────────────
router.post(
  '/:id',
  asyncHandler(async (req, res) => {
    try {
      const input = UpdateUserSchema.parse(req.body);
      await updateUser({ req, actor: actorFrom(req), userId: req.params.id, input });
      res.redirect(`/admin/users/${req.params.id}/edit?ok=updated`);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).render('users-form', {
          user: req.user, mode: 'edit',
          target: { ...bodyToForm(req.body), id: req.params.id },
          errors: zodToErrors(err), formError: 'Periksa kembali isian form.', META,
        });
      }
      if (err instanceof HttpError && (err.status === 409 || err.status === 400 || err.status === 403)) {
        return res.status(err.status).render('users-form', {
          user: req.user, mode: 'edit',
          target: { ...bodyToForm(req.body), id: req.params.id },
          errors: { _: err.message }, formError: err.message, META,
        });
      }
      throw err;
    }
  }),
);

// ── POST /admin/users/:id/reset-password ─────────────────────
router.post(
  '/:id/reset-password',
  asyncHandler(async (req, res) => {
    try {
      const { password } = PasswordSchema.parse(req.body);
      await setPassword({ req, actor: actorFrom(req), userId: req.params.id, password });
      res.redirect(`/admin/users/${req.params.id}/edit?ok=password`);
    } catch (err) {
      const msg = err instanceof ZodError ? err.issues[0].message : err.message;
      res.redirect(`/admin/users/${req.params.id}/edit?err=${encodeURIComponent(msg)}`);
    }
  }),
);

// ── POST /admin/users/:id/suspend ────────────────────────────
router.post(
  '/:id/suspend',
  asyncHandler(async (req, res) => {
    try {
      await suspendUser({ req, actor: actorFrom(req), userId: req.params.id });
      res.redirect(`/admin/users/${req.params.id}/edit?ok=suspended`);
    } catch (err) {
      res.redirect(`/admin/users/${req.params.id}/edit?err=${encodeURIComponent(err.message)}`);
    }
  }),
);

// ── POST /admin/users/:id/reactivate ─────────────────────────
router.post(
  '/:id/reactivate',
  asyncHandler(async (req, res) => {
    try {
      await reactivateUser({ req, actor: actorFrom(req), userId: req.params.id });
      res.redirect(`/admin/users/${req.params.id}/edit?ok=reactivated`);
    } catch (err) {
      res.redirect(`/admin/users/${req.params.id}/edit?err=${encodeURIComponent(err.message)}`);
    }
  }),
);

export default router;
