import { db } from '../lib/db.js';
import { verifyToken } from '../lib/jwt.js';
import { readToken, serializeUser } from '../lib/auth.js';
import { HttpError } from './error.js';
import { asyncHandler } from '../lib/asyncHandler.js';

/**
 * Best-effort: populate req.user if a valid token is present, but allow
 * anonymous requests through. Use for routes that vary by login state
 * but don't require it (e.g. paket detail page rendering).
 */
export const optionalAuth = asyncHandler(async (req, _res, next) => {
  const token = readToken(req);
  if (!token) return next();
  try {
    const payload = verifyToken(token);
    const user = await db.user.findUnique({ where: { id: payload.sub } });
    if (user && !user.deletedAt && user.status === 'ACTIVE') {
      req.user = serializeUser(user);
      req.tokenPayload = payload;
    }
  } catch {
    // ignore — treat as anonymous
  }
  next();
});

/**
 * Hard requirement: valid token + active, non-deleted user.
 */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = readToken(req);
  if (!token) throw new HttpError(401, 'Anda harus login terlebih dahulu', 'AUTH_REQUIRED');

  const payload = verifyToken(token); // throws 401 on invalid/expired
  const user = await db.user.findUnique({ where: { id: payload.sub } });

  if (!user || user.deletedAt) {
    throw new HttpError(401, 'Sesi tidak valid', 'TOKEN_INVALID');
  }
  if (user.status !== 'ACTIVE') {
    throw new HttpError(403, 'Akun Anda tidak aktif', 'ACCOUNT_INACTIVE');
  }

  req.user = serializeUser(user);
  req.tokenPayload = payload;
  next();
});

/**
 * Role guard. Use after requireAuth.
 *   router.get('/admin', requireAuth, requireRole('OWNER', 'SUPERADMIN'), …)
 */
export function requireRole(...allowed) {
  if (allowed.length === 0) throw new Error('requireRole(): at least one role needed');
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Anda harus login', 'AUTH_REQUIRED'));
    if (!allowed.includes(req.user.role)) {
      return next(
        new HttpError(403, `Akses ditolak. Peran yang diizinkan: ${allowed.join(', ')}`, 'FORBIDDEN'),
      );
    }
    next();
  };
}
