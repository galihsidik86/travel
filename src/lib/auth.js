import bcrypt from 'bcryptjs';

const BCRYPT_COST = 10;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/**
 * Strip sensitive fields before sending User to client.
 */
export function serializeUser(user) {
  if (!user) return null;
  const { passwordHash, deletedAt, ...safe } = user;
  return safe;
}

/**
 * Reads JWT from `Authorization: Bearer …` header first, then
 * falls back to the rp_session httpOnly cookie.
 */
export function readToken(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.cookies?.rp_session || null;
}
