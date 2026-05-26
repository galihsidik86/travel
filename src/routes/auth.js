import { Router } from 'express';
import { z } from 'zod';

import { db } from '../lib/db.js';
import { hashPassword, comparePassword, serializeUser } from '../lib/auth.js';
import { signToken, COOKIE_NAME, cookieOptions } from '../lib/jwt.js';
import { audit } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

// ── Rate limiters ────────────────────────────────────────────
const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, code: 'LOGIN_RATE_LIMITED' });
const registerLimiter = rateLimit({ windowMs: 60_000, max: 5, code: 'REGISTER_RATE_LIMITED' });

// ── Validation schemas ───────────────────────────────────────
const RegisterSchema = z.object({
  email: z.string().email('Email tidak valid').max(190).toLowerCase(),
  password: z.string().min(8, 'Password minimal 8 karakter').max(200),
  fullName: z.string().min(2, 'Nama lengkap minimal 2 karakter').max(190),
  phone: z.string().min(8, 'Nomor telepon tidak valid').max(30).optional(),
});

const LoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

// ── POST /register ───────────────────────────────────────────
// Public registration. Creates a JEMAAH-role user + linked JemaahProfile.
// Other roles (AGEN, STAFF, OWNER, etc.) must be created by an admin.
router.post(
  '/register',
  registerLimiter,
  asyncHandler(async (req, res) => {
    const data = RegisterSchema.parse(req.body);

    const existing = await db.user.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new HttpError(409, 'Email sudah terdaftar', 'EMAIL_TAKEN');
    }

    const passwordHash = await hashPassword(data.password);

    const user = await db.user.create({
      data: {
        email: data.email,
        passwordHash,
        role: 'JEMAAH',
        fullName: data.fullName,
        phone: data.phone,
        jemaah: {
          create: {
            fullName: data.fullName,
            phone: data.phone ?? '',
          },
        },
      },
    });

    await audit({
      req,
      actor: { id: user.id, email: user.email, role: user.role },
      action: 'CREATE',
      entity: 'User',
      entityId: user.id,
      after: { email: user.email, role: user.role, fullName: user.fullName },
    });

    const token = signToken({ sub: user.id, role: user.role, email: user.email });
    res.cookie(COOKIE_NAME, token, cookieOptions());

    res.status(201).json({ user: serializeUser(user), token });
  }),
);

// ── POST /login ──────────────────────────────────────────────
router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = LoginSchema.parse(req.body);

    const user = await db.user.findUnique({ where: { email } });

    // Generic message to avoid revealing whether email exists
    const fail = async (reason) => {
      await audit({
        req,
        actor: user ? { id: user.id, email: user.email, role: user.role } : { email },
        action: 'LOGIN',
        entity: 'User',
        entityId: user?.id ?? null,
        after: { ok: false, reason },
      });
      throw new HttpError(401, 'Email atau password salah', 'LOGIN_FAILED');
    };

    if (!user || user.deletedAt) return fail('not_found_or_deleted');
    if (user.status !== 'ACTIVE') return fail('inactive');

    const ok = await comparePassword(password, user.passwordHash);
    if (!ok) return fail('bad_password');

    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await audit({
      req,
      actor: { id: user.id, email: user.email, role: user.role },
      action: 'LOGIN',
      entity: 'User',
      entityId: user.id,
      after: { ok: true },
    });

    const token = signToken({ sub: user.id, role: user.role, email: user.email });
    res.cookie(COOKIE_NAME, token, cookieOptions());

    res.json({ user: serializeUser(user), token });
  }),
);

// ── POST /logout ─────────────────────────────────────────────
router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    // Try to identify the actor for the audit row, but don't require auth
    // (logout should always succeed from the client's perspective).
    let actor = null;
    try {
      const { verifyToken } = await import('../lib/jwt.js');
      const { readToken } = await import('../lib/auth.js');
      const t = readToken(req);
      if (t) {
        const payload = verifyToken(t);
        actor = { id: payload.sub, email: payload.email, role: payload.role };
      }
    } catch {
      // ignore
    }

    res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });

    if (actor) {
      await audit({ req, actor, action: 'LOGOUT', entity: 'User', entityId: actor.id });
    }
    res.json({ ok: true });
  }),
);

// ── GET /me ──────────────────────────────────────────────────
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await db.user.findUnique({
      where: { id: req.user.id },
      include: {
        agent: true,
        jemaah: true,
        staff: true,
        crew: true,
      },
    });
    res.json({ user: serializeUser(user) });
  }),
);

export default router;
