// Stage 299 — per-recipient daily cap. Prevents one jemaah from
// getting flooded by multiple crons firing the same day.
//
// Cap is per-(recipient, channel) — a jemaah might get 6 WA + 3 EMAIL
// in one day before hitting either cap. Defaults:
//   - WA: 5 messages/24h (loud channel)
//   - EMAIL: 15 messages/24h (mostly digests, less intrusive)
//
// Urgent types bypass (life-safety + admin-action; same set as S298
// quiet hours, sourced from there for consistency).
//
// Admin-targeted notifs bypass — admins have their own opt-out via
// S300.
//
// Over-cap returns `{defer: true, deferUntil}` — caller bumps
// nextRetryAt to that time (24h after the oldest counted notif).

import { db } from '../lib/db.js';
import { URGENT_TYPES } from './notifQuietHours.js';
import { env } from '../env.js';

function parseCap(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

export function getDailyCapConfig() {
  const wa = parseCap(env?.NOTIF_DAILY_CAP_WA ?? process.env.NOTIF_DAILY_CAP_WA, 5);
  const email = parseCap(env?.NOTIF_DAILY_CAP_EMAIL ?? process.env.NOTIF_DAILY_CAP_EMAIL, 15);
  return { wa, email };
}

/**
 * Look up how many SENT notifs the recipient got via this channel
 * within the last 24h.
 *
 * Returns the count + the oldest counted notif's createdAt (so the
 * caller can defer until that ages out).
 */
export async function countRecentForRecipient({ channel, recipientPhone, recipientEmail, now = new Date() }) {
  const cutoff = new Date(now.getTime() - 24 * 3_600_000);
  const where = {
    channel,
    status: { in: ['SENT'] },
    sentAt: { gte: cutoff },
  };
  if (channel === 'WA' && recipientPhone) where.recipientPhone = recipientPhone;
  else if (channel === 'EMAIL' && recipientEmail) where.recipientEmail = recipientEmail;
  else return { count: 0, oldest: null };

  const rows = await db.notification.findMany({
    where, select: { sentAt: true },
    orderBy: { sentAt: 'asc' }, take: 100,
  });
  return {
    count: rows.length,
    oldest: rows.length > 0 ? rows[0].sentAt : null,
  };
}

/**
 * Decide if `notif` should be deferred due to the daily cap.
 * Returns `{defer: false}` or `{defer: true, deferUntil}`.
 *
 * Async because it reads the DB to count recent notifs.
 */
export async function evaluateDailyCap(notif, { now = new Date() } = {}) {
  // Urgent bypasses
  if (URGENT_TYPES.has(notif?.type)) return { defer: false };
  // Admin-targeted bypasses (no recipientUserId AND only an email)
  if (notif?.recipientUserId == null) return { defer: false };

  const { wa, email } = getDailyCapConfig();
  let cap;
  if (notif.channel === 'WA') cap = wa;
  else if (notif.channel === 'EMAIL') cap = email;
  else return { defer: false }; // unknown channel — let through

  const { count, oldest } = await countRecentForRecipient({
    channel: notif.channel,
    recipientPhone: notif.recipientPhone,
    recipientEmail: notif.recipientEmail,
    now,
  });

  if (count < cap) return { defer: false };

  // Over cap — defer until the oldest counted notif ages out (oldest + 24h + 1min buffer)
  const deferUntil = oldest
    ? new Date(oldest.getTime() + 24 * 3_600_000 + 60_000)
    : new Date(now.getTime() + 4 * 3_600_000); // defensive 4h fallback

  return { defer: true, deferUntil, count, cap };
}
