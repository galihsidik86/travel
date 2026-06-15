// Stage 298 — quiet hours gate for notif dispatch.
//
// Defers non-urgent WA messages outside business hours so jemaah
// aren't pinged at 3 AM by an automated cron. EMAIL is always allowed
// (inbox can wait); WA is louder so we gate it.
//
// Business hours configurable via env:
//   NOTIF_QUIET_HOURS_START (24h, default "21" = 9 PM)
//   NOTIF_QUIET_HOURS_END   (24h, default "7"  = 7 AM)
//   NOTIF_QUIET_HOURS_TZ    (IANA TZ, default "Asia/Jakarta")
//
// Urgent types bypass the gate (life-safety + admin-action notifs):
//   - INCIDENT_REPORTED, INCIDENT_ESCALATED, INCIDENT_SLA_BREACH_OWNER
//   - CANCEL_REQUESTED, PAYMENT_SETTLED_ADMIN
//   - BOOKING_HANDOVER (admin needs to act; jemaah needs immediate
//     awareness of ownership change)
//   - all admin-targeted notifs (have NO recipientUserId set; admins
//     have their own opt-out via S300, not quiet hours)
//
// "Defer" means we bump the notif's nextRetryAt to the next dispatch
// window start + leave status PENDING. The retry mechanism (S5nn)
// picks it up naturally when the window opens.

import { env } from '../env.js';

const URGENT_TYPES = new Set([
  'INCIDENT_REPORTED',
  'INCIDENT_ESCALATED',
  'INCIDENT_SLA_BREACH_OWNER',
  'CANCEL_REQUESTED',
  'PAYMENT_SETTLED_ADMIN',
  'BOOKING_HANDOVER',
  // S211 / S214 / S277 etc. — crew dietary etc are mostly EMAIL anyway
]);

function parseHour(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 23) return fallback;
  return Math.floor(n);
}

/**
 * Read configured window. Pure function so tests can override.
 */
export function getQuietHoursConfig() {
  const start = parseHour(env?.NOTIF_QUIET_HOURS_START ?? process.env.NOTIF_QUIET_HOURS_START, 21);
  const end = parseHour(env?.NOTIF_QUIET_HOURS_END ?? process.env.NOTIF_QUIET_HOURS_END, 7);
  const tz = (env?.NOTIF_QUIET_HOURS_TZ ?? process.env.NOTIF_QUIET_HOURS_TZ) || 'Asia/Jakarta';
  return { start, end, tz };
}

/**
 * Returns the hour-of-day (0-23) in the configured TZ.
 */
export function hourInTz(date, tz) {
  // Intl returns "23" or "23:45"; we just need the hour.
  try {
    const h = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: 'numeric', hour12: false,
    }).format(date);
    // Some locales return "24" for midnight; normalise to 0.
    const n = parseInt(h, 10);
    if (n === 24) return 0;
    return Number.isFinite(n) ? n : date.getHours();
  } catch {
    return date.getHours();
  }
}

/**
 * Is `hour` inside the quiet window? Window may cross midnight
 * (start=21, end=7 → quiet 21:00→07:00 means 22, 23, 0, 1, ..., 6 ⇒ true).
 */
export function inQuietWindow(hour, start, end) {
  if (start === end) return false; // window is empty
  if (start < end) return hour >= start && hour < end;
  // wraps midnight
  return hour >= start || hour < end;
}

/**
 * Decide if `notif` should be deferred. Returns either
 * `{ defer: false }` (let dispatch proceed) or
 * `{ defer: true, deferUntil }` (bump nextRetryAt to start of next active window).
 */
export function evaluateQuietHours(notif, { now = new Date() } = {}) {
  // Only WA is gated. EMAIL goes anytime (inbox is async).
  if (notif?.channel !== 'WA') return { defer: false };
  // Urgent types bypass.
  if (URGENT_TYPES.has(notif?.type)) return { defer: false };
  // Admin-targeted notifs (no recipientUserId) follow per-admin prefs (S300),
  // not quiet hours — admins working late should still see SOS, etc.
  if (notif?.recipientUserId == null) return { defer: false };

  const { start, end, tz } = getQuietHoursConfig();
  const hour = hourInTz(now, tz);
  if (!inQuietWindow(hour, start, end)) return { defer: false };

  // Compute next dispatch window: today at `end` hour, in tz. If we
  // already passed today's `end` hour (impossible while in quiet window
  // by definition for non-wrap case, but defensive), defer to tomorrow.
  const deferUntil = nextWindowOpen(now, { start, end, tz });
  return { defer: true, deferUntil };
}

/**
 * Compute the next moment dispatch is allowed (start of next active
 * window). Returned as a UTC Date.
 *
 * Simple model: defer to `end` hour today (in tz). If `end` hour is in
 * the past today, add 24 hours.
 *
 * Edge case: when window wraps midnight (start=21, end=7) and current
 * time is 23:00, "end" is 07:00 tomorrow. We construct a TZ-aware
 * approximation via a 1-hour buffer iteration (cheap; runs at most
 * ~25 times).
 */
export function nextWindowOpen(now, { start, end, tz }) {
  // Try the next 25 hours one hour at a time; first hour not in window
  // is our answer (rounded to the hour).
  for (let i = 1; i <= 25; i += 1) {
    const candidate = new Date(now.getTime() + i * 3_600_000);
    const h = hourInTz(candidate, tz);
    if (!inQuietWindow(h, start, end)) {
      // Round to the top of the hour for cleaner scheduling
      const rounded = new Date(candidate);
      rounded.setMinutes(0, 0, 0);
      return rounded;
    }
  }
  // Defensive fallback — defer 4 hours
  return new Date(now.getTime() + 4 * 3_600_000);
}

export { URGENT_TYPES };
