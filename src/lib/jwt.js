import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { HttpError } from '../middleware/error.js';

const SECRET = env.JWT_SECRET;
const TTL = env.JWT_TTL;
const ISSUER = 'religio-pro';

function ensureSecret() {
  if (!SECRET) {
    throw new HttpError(500, 'Server tidak dikonfigurasi: JWT_SECRET kosong', 'CONFIG_ERROR');
  }
}

export function signToken(payload, opts = {}) {
  ensureSecret();
  return jwt.sign(payload, SECRET, {
    expiresIn: opts.expiresIn ?? TTL,
    issuer: ISSUER,
  });
}

export function verifyToken(token) {
  ensureSecret();
  try {
    return jwt.verify(token, SECRET, { issuer: ISSUER });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new HttpError(401, 'Sesi Anda berakhir, silakan login kembali', 'TOKEN_EXPIRED');
    }
    throw new HttpError(401, 'Token tidak valid', 'TOKEN_INVALID');
  }
}

export const COOKIE_NAME = 'rp_session';

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN === 'localhost' ? undefined : env.COOKIE_DOMAIN,
    path: '/',
    maxAge: parseTtlToMs(TTL),
  };
}

function parseTtlToMs(ttl) {
  // supports "7d", "12h", "30m", "60s", or raw seconds
  const m = String(ttl).match(/^(\d+)([smhd])?$/);
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const u = m[2] || 's';
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[u];
  return n * mult;
}
