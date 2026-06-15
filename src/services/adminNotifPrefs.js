// Stage 300 — per-admin notif type opt-out.
//
// Admin opens `/admin/notif-prefs` and toggles a checkbox per notif
// type. Absence of an AdminNotifPref row = opt-in (default behaviour
// so existing behaviour is unchanged for admins who never visit the
// prefs page).
//
// Wire-in: `enqueueNotification` reads any AdminNotifPref row for the
// recipient (resolved by recipientEmail → user lookup) and skips the
// enqueue when `enabled=false`. The row is stamped SKIPPED with reason
// so the admin queue viewer + retention pruner handle it cleanly.

import { db } from '../lib/db.js';

const ADMIN_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR', 'SALES'];

// Notif types relevant to admin recipients (excludes jemaah/agent/crew-
// targeted types). Sourced from the actual enum — keeping the list
// surface-explicit so the UI doesn't show toggles for irrelevant types.
export const ADMIN_NOTIF_TYPES = [
  'CANCEL_REQUESTED',
  'PAYMENT_SETTLED_ADMIN',
  'INCIDENT_REPORTED',
  'INCIDENT_ESCALATED',
  'INCIDENT_SLA_BREACH_OWNER',
  'DAILY_DIGEST_OWNER',
  'WEEKLY_DIGEST_OWNER',
  'PAYOUT_REMINDER_OWNER',
  'TRAFFIC_ANOMALY_OWNER',
  'LANDING_SLOW_OWNER',
  'WAITLIST_SLOT_FREED',
  'TASK_OVERDUE_ESCALATION',
  'API_KEY_SCOPE_DOWN_OWNER',
  'WEBHOOK_HEALTH_OWNER',
  'INSTALLMENT_OVERDUE_ADMIN',
  'DOC_VERIFY_SLA_ADMIN',
  'CREW_DAILY_REPORT_MISSED_ADMIN',
  'BOOKING_NOTE_MENTION',
  'GENERIC',
];

const ADMIN_NOTIF_TYPE_SET = new Set(ADMIN_NOTIF_TYPES);

/**
 * Read this admin's prefs as a map {type → enabled}.
 * Missing rows default to enabled=true.
 */
export async function getAdminPrefs(userId) {
  if (!userId) return {};
  const rows = await db.adminNotifPref.findMany({
    where: { userId },
    select: { type: true, enabled: true },
  });
  return Object.fromEntries(rows.map((r) => [r.type, r.enabled]));
}

/**
 * Bulk set prefs from a `{type: enabled}` object. Used by the prefs
 * form (one POST applies all changes). Unknown types are ignored.
 */
export async function setAdminPrefs({ userId, prefs }) {
  if (!userId) return { updated: 0 };
  if (!prefs || typeof prefs !== 'object') return { updated: 0 };
  let updated = 0;
  for (const [type, raw] of Object.entries(prefs)) {
    if (!ADMIN_NOTIF_TYPE_SET.has(type)) continue;
    const enabled = raw === true || raw === 'true' || raw === 'on' || raw === '1';
    await db.adminNotifPref.upsert({
      where: { userId_type: { userId, type } },
      update: { enabled },
      create: { userId, type, enabled },
    });
    updated += 1;
  }
  return { updated };
}

/**
 * Resolve whether the prefs say to skip this notif. Called from
 * enqueueNotification (before the row is created). Returns
 * `{ skip: true, reason }` or `{ skip: false }`.
 *
 * Strategy: look up the recipient by email (the load-bearing field for
 * admin-targeted notifs). If they're an admin AND have an opted-out
 * AdminNotifPref row for this type, skip.
 *
 * Best-effort: lookup failure logs but returns `{ skip: false }` so
 * we err on the side of delivering.
 */
export async function shouldSkipForAdminPrefs({ type, recipientEmail }) {
  if (!type || !recipientEmail) return { skip: false };
  if (!ADMIN_NOTIF_TYPE_SET.has(type)) return { skip: false };
  try {
    const user = await db.user.findUnique({
      where: { email: recipientEmail },
      select: { id: true, role: true, status: true },
    });
    if (!user) return { skip: false };
    if (user.status !== 'ACTIVE') return { skip: false };
    if (!ADMIN_ROLES.includes(user.role)) return { skip: false };
    const pref = await db.adminNotifPref.findUnique({
      where: { userId_type: { userId: user.id, type } },
      select: { enabled: true },
    });
    if (pref && pref.enabled === false) {
      return { skip: true, reason: `recipient opted out of ${type} notifications` };
    }
    return { skip: false };
  } catch (err) {
    console.warn('[adminNotifPrefs] lookup failed (sending):', err?.message || err);
    return { skip: false };
  }
}
