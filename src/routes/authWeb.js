// Browser-facing auth: HTML login form + form-encoded POST.
// Mirrors /api/auth/login but redirects by role on success and re-renders
// the form with an error message on failure.
import { Router } from 'express';
import { z } from 'zod';

import { db } from '../lib/db.js';
import { comparePassword } from '../lib/auth.js';
import { signToken, COOKIE_NAME, cookieOptions } from '../lib/jwt.js';
import { audit } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, code: 'LOGIN_RATE_LIMITED' });

const LoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

function redirectForRole(role) {
  if (role === 'AGEN') return '/agen';
  if (role === 'JEMAAH') return '/saya';
  if (role === 'MUTHAWWIF') return '/crew';  // 5oo
  if (['OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR'].includes(role)) return '/admin';
  return '/';
}

router.get('/login', (req, res) => {
  res.render('login', { error: null, email: '', next: req.query.next || '' });
});

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).render('login', {
        error: 'Email atau password tidak valid',
        email: req.body?.email || '',
        next: req.body?.next || '',
      });
    }
    const { email, password } = parsed.data;

    const user = await db.user.findUnique({ where: { email } });

    const fail = async (reason) => {
      await audit({
        req,
        actor: user ? { id: user.id, email: user.email, role: user.role } : { email },
        action: 'LOGIN',
        entity: 'User',
        entityId: user?.id ?? null,
        after: { ok: false, reason, via: 'web' },
      });
      return res.status(401).render('login', {
        error: 'Email atau password salah',
        email,
        next: req.body?.next || '',
      });
    };

    if (!user || user.deletedAt) return fail('not_found_or_deleted');
    if (user.status !== 'ACTIVE') return fail('inactive');

    const ok = await comparePassword(password, user.passwordHash);
    if (!ok) return fail('bad_password');

    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit({
      req,
      actor: { id: user.id, email: user.email, role: user.role },
      action: 'LOGIN',
      entity: 'User',
      entityId: user.id,
      after: { ok: true, via: 'web' },
    });

    const token = signToken({ sub: user.id, role: user.role, email: user.email });
    res.cookie(COOKIE_NAME, token, cookieOptions());

    const next = typeof req.body?.next === 'string' && req.body.next.startsWith('/')
      ? req.body.next
      : redirectForRole(user.role);
    res.redirect(next);
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
    res.redirect('/login');
  }),
);

export default router;
