// Stage 232-234 — booking tag autopilot. Three rules fire from the
// booking row + jemaah + paket data we already have:
//
//   LANSIA    — jemaah age ≥ 60 at paket departureDate (S232)
//   PERTAMA   — jemaah has zero prior LUNAS bookings, anywhere (S233)
//   KELUARGA  — ≥3 active bookings on this paket share an emergencyContact (S234)
//
// All rules are **additive only** — auto-tags never replace admin-curated
// tags from S226. Admin can manually remove them after the fact (next
// auto-tag pass won't re-add them on the same booking unless the
// underlying signal changes — see "no re-add" rule below).
//
// KELUARGA backfills: when the Nth booking trips the threshold, all
// other active bookings on the paket with the same emergencyContact
// get tagged too (the first 2 don't yet have KELUARGA when they're
// individually created). Backfill is done via `retroTagKeluargaCohort`
// which is called from `autoTagBooking` after the per-row pass.
//
// "No re-add" rule (idempotency): auto-tag never re-adds a tag that
// was once added and later removed by admin. The Booking.autoTaggedSeen
// JSON column (S232 migration) records which auto-tags have already
// been computed for this booking — if KELUARGA was once added and is
// now absent from `tags`, we don't re-add it. Without this rule the
// auto-tag worker would fight admin's intentional removals on every
// run, which would be hostile UX.

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { normaliseBookingTags } from './bookingAdmin.js';

export const AUTO_TAGS = ['LANSIA', 'PERTAMA', 'KELUARGA'];
export const KELUARGA_THRESHOLD = 3;
export const LANSIA_AGE = 60;

function ageAt(birthDate, when) {
  const b = new Date(birthDate);
  const w = new Date(when);
  let age = w.getFullYear() - b.getFullYear();
  const beforeBirthday = (w.getMonth() < b.getMonth())
    || (w.getMonth() === b.getMonth() && w.getDate() < b.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/**
 * Pure-compute auto-tag list from already-loaded data + counts. No DB
 * access — caller wraps with the count queries. Returned array is
 * subset of AUTO_TAGS in stable order.
 */
export function computeAutoTagsPure({ jemaah, paket, priorLunasCount = 0, sharedEcContactBookingCount = 0 }) {
  const out = [];
  if (jemaah?.birthDate && paket?.departureDate) {
    const age = ageAt(jemaah.birthDate, paket.departureDate);
    if (age >= LANSIA_AGE) out.push('LANSIA');
  }
  if (priorLunasCount === 0) out.push('PERTAMA');
  if (jemaah?.emergencyContact && sharedEcContactBookingCount >= KELUARGA_THRESHOLD) {
    out.push('KELUARGA');
  }
  return out;
}

/**
 * Compute the LANSIA + PERTAMA + KELUARGA signals for one booking by
 * running the count queries. Returns the auto-tag list (may be empty).
 *
 * `bookingId` is excluded from the prior-LUNAS count so re-running on
 * an already-LUNAS booking doesn't accidentally inflate the count.
 */
export async function computeAutoTagsForBooking(bookingId) {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, jemaahId: true, paketId: true, status: true,
      paket: { select: { id: true, departureDate: true } },
      jemaah: { select: { id: true, birthDate: true, emergencyContact: true } },
    },
  });
  if (!booking) return [];

  // S233 — count prior LUNAS bookings for this jemaah. We count via
  // jemaahId (the JemaahProfile FK) — the canonical identity per S5p.2
  // claim/merge. Exclude the current booking from the count so the
  // "this is your first" check stays correct even on re-run.
  const priorLunasCount = await db.booking.count({
    where: {
      jemaahId: booking.jemaahId,
      status: 'LUNAS',
      id: { not: bookingId },
    },
  });

  // S234 — count active bookings on this paket with the same
  // emergencyContact (anti-leak: empty/whitespace string never matches).
  let sharedEcContactBookingCount = 0;
  const ec = booking.jemaah?.emergencyContact?.trim();
  if (ec) {
    sharedEcContactBookingCount = await db.booking.count({
      where: {
        paketId: booking.paketId,
        status: { notIn: ['CANCELLED', 'REFUNDED'] },
        jemaah: { emergencyContact: ec },
      },
    });
  }

  return computeAutoTagsPure({
    jemaah: booking.jemaah,
    paket: booking.paket,
    priorLunasCount,
    sharedEcContactBookingCount,
  });
}

/**
 * Apply auto-tags to a booking. **Additive only** — never removes a
 * tag, never overwrites admin-curated ones. Respects the "no re-add"
 * rule via `Booking.autoTaggedSeen` so admin's manual removal sticks.
 *
 * Returns `{ added: [...], skipped: [...] }` where added is the list
 * of NEW auto-tags written this pass, and skipped is the list of
 * auto-tags that the rules computed but admin had previously removed.
 *
 * No audit row when nothing changed (skip-when-no-op convention).
 */
export async function autoTagBooking({ req, actor, bookingId }) {
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, bookingNo: true, status: true, tags: true, autoTaggedSeen: true },
  });
  if (!before) return { added: [], skipped: [], retroCohort: 0 };
  // Skip CANCELLED/REFUNDED — frozen history shouldn't gain new tags.
  if (before.status === 'CANCELLED' || before.status === 'REFUNDED') {
    return { added: [], skipped: [], retroCohort: 0 };
  }

  const computed = await computeAutoTagsForBooking(bookingId);
  const currentTags = Array.isArray(before.tags) ? before.tags : [];
  const seen = Array.isArray(before.autoTaggedSeen) ? before.autoTaggedSeen : [];

  // "No re-add" rule: drop computed tags that have been seen before AND
  // are no longer present on the booking (admin removed them).
  const added = [];
  const skipped = [];
  for (const t of computed) {
    if (currentTags.includes(t)) continue; // already there, nothing to do
    if (seen.includes(t)) { skipped.push(t); continue; } // admin removed; respect it
    added.push(t);
  }

  if (added.length === 0) {
    // Still record any newly-computed-but-skipped state into seen so the
    // signal is captured. Without this the autopilot keeps re-evaluating
    // the same skipped tags every run (harmless but wastes work).
    return { added: [], skipped, retroCohort: 0 };
  }

  const nextTags = normaliseBookingTags([...currentTags, ...added]);
  const nextSeen = [...new Set([...seen, ...added])];

  await db.booking.update({
    where: { id: bookingId },
    data: { tags: nextTags, autoTaggedSeen: nextSeen },
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { tags: currentTags },
    after: {
      tags: nextTags,
      tagsChanged: true,
      autoTagged: true,
      autoTagsAdded: added,
      autoTagsSkipped: skipped,
    },
  });

  // KELUARGA retro: when this pass added KELUARGA, the OTHER bookings
  // in the same emergencyContact cohort might not have it yet. Fan out.
  let retroCohort = 0;
  if (added.includes('KELUARGA')) {
    retroCohort = await retroTagKeluargaCohort({ req, actor, bookingId });
  }

  return { added, skipped, retroCohort };
}

/**
 * S234 backfill — when one booking trips KELUARGA, find all OTHER
 * active bookings on the same paket with the same emergencyContact
 * that haven't been auto-tagged KELUARGA yet, and add it. Excludes
 * bookings where admin previously removed KELUARGA (the "no re-add"
 * rule applies to cohort members too).
 */
export async function retroTagKeluargaCohort({ req, actor, bookingId }) {
  const seed = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      paketId: true,
      jemaah: { select: { emergencyContact: true } },
    },
  });
  const ec = seed?.jemaah?.emergencyContact?.trim();
  if (!ec) return 0;

  const cohort = await db.booking.findMany({
    where: {
      paketId: seed.paketId,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      jemaah: { emergencyContact: ec },
      id: { not: bookingId },
    },
    select: { id: true, tags: true, autoTaggedSeen: true },
  });

  let touched = 0;
  for (const row of cohort) {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    const seen = Array.isArray(row.autoTaggedSeen) ? row.autoTaggedSeen : [];
    if (tags.includes('KELUARGA')) continue;
    if (seen.includes('KELUARGA')) continue; // admin removed; respect
    const nextTags = normaliseBookingTags([...tags, 'KELUARGA']);
    const nextSeen = [...new Set([...seen, 'KELUARGA'])];
    await db.booking.update({
      where: { id: row.id },
      data: { tags: nextTags, autoTaggedSeen: nextSeen },
    });
    await audit({
      req, actor,
      action: 'UPDATE', entity: 'Booking', entityId: row.id,
      before: { tags },
      after: {
        tags: nextTags, tagsChanged: true,
        autoTagged: true, autoTagsAdded: ['KELUARGA'],
        retroFromBookingId: bookingId,
      },
    });
    touched += 1;
  }
  return touched;
}

/**
 * Batch entry — scans active bookings on non-archived future-departure
 * paket and auto-tags each. Used by the daily backfill cron. Per-row
 * failure caught so a bad row doesn't abort the batch.
 */
export async function runAutoTagBackfill({ now = new Date() } = {}) {
  const bookings = await db.booking.findMany({
    where: {
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      paket: {
        status: { not: 'ARCHIVED' },
        deletedAt: null,
        departureDate: { gte: now },
      },
    },
    select: { id: true },
  });
  const actor = { id: null, email: 'system', role: null };
  const req = { ip: null, headers: {}, get: () => null };
  let touched = 0;
  let failed = 0;
  for (const b of bookings) {
    try {
      const r = await autoTagBooking({ req, actor, bookingId: b.id });
      if (r.added.length > 0 || r.retroCohort > 0) touched += 1;
    } catch (err) {
      console.warn('[autoTagBackfill]', b.id, err?.message || err);
      failed += 1;
    }
  }
  return { scanned: bookings.length, touched, failed };
}
