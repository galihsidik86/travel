// Stage 259 — manual group assignment + clear. Admin links pre-existing
// bookings into a group without going through clone (S256/S257). Useful
// when a family booked separately + we want them grouped after the fact.
//
// S260 layer on top — BookingGroup row carries a human-friendly label
// shared across every member of the group (set once, surfaces everywhere).
//
// Group keys minted here use the same `G-XXXXXX` shape as S257 so manual
// + clone-born groups are indistinguishable downstream.

import { randomBytes } from 'node:crypto';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const GROUP_KEY_RE = /^G-[A-Z0-9]{4,12}$/;

export function generateGroupKey() {
  return `G-${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
}

/**
 * Normalise + validate a user-supplied groupKey.
 *   - Trims, uppercases.
 *   - Accepts `G-XXXX` to `G-XXXXXXXXXXXX` (4-12 alnum after the prefix).
 *   - Returns null on empty/invalid (caller decides whether that's an error
 *     or a "clear" signal — depends on context).
 */
export function normaliseGroupKey(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  if (!GROUP_KEY_RE.test(s)) return null;
  return s;
}

/**
 * Set or change a booking's groupKey. Three modes:
 *   - `groupKey === null`  → clear (booking leaves the group)
 *   - `groupKey === 'NEW'` → mint a fresh G-XXXXXX and assign
 *   - `groupKey` valid     → assign to existing or new group with that key
 *
 * Refuses on CANCELLED/REFUNDED (frozen state). No-op when value matches
 * current — no audit pollution.
 *
 * Does NOT require the target groupKey to already exist on another
 * booking — admin can "pre-create" a group by assigning the first
 * booking, then add siblings one at a time. S260 group label lives in
 * a separate BookingGroup row that can be created independently.
 */
export async function setBookingGroupKey({ req, actor, bookingId, groupKey }) {
  const before = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, bookingNo: true, status: true, groupKey: true },
  });
  if (!before) throw new HttpError(404, 'Booking tidak ditemukan', 'BOOKING_NOT_FOUND');
  if (before.status === 'CANCELLED' || before.status === 'REFUNDED') {
    throw new HttpError(409, 'Booking sudah cancelled/refunded — groupKey beku', 'BOOKING_CLOSED');
  }

  let nextKey;
  let created = false;
  if (groupKey === null || groupKey === '') {
    nextKey = null;
  } else if (typeof groupKey === 'string' && groupKey.trim().toUpperCase() === 'NEW') {
    nextKey = generateGroupKey();
    created = true;
  } else {
    nextKey = normaliseGroupKey(groupKey);
    if (nextKey == null) {
      throw new HttpError(400, 'Format groupKey tidak valid (contoh: G-AB12CD)', 'BAD_GROUP_KEY');
    }
  }

  if (before.groupKey === nextKey) return { updated: false, groupKey: nextKey };

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { groupKey: nextKey },
    select: { id: true, groupKey: true },
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Booking', entityId: bookingId,
    before: { groupKey: before.groupKey },
    after: { groupKey: nextKey, groupKeyManuallySet: true, groupCreated: created },
  });

  // Stage 260 — best-effort: pre-create a BookingGroup row for the new
  // group key so admin's "set label" form has a row to update. Idempotent
  // upsert; never blocks the booking write if it fails.
  if (nextKey && created) {
    try {
      await db.bookingGroup.upsert({
        where: { groupKey: nextKey },
        update: {},
        create: { groupKey: nextKey, label: null, notes: null },
      });
    } catch (err) {
      console.warn('[setBookingGroupKey] bookingGroup pre-create failed:', err?.message || err);
    }
  }

  return { updated: true, groupKey: updated.groupKey, groupCreated: created };
}

/**
 * Stage 260 — fetch group metadata + member list. Returns null when
 * the groupKey doesn't exist as a BookingGroup row AND no member
 * booking carries it (truly unknown). When the row is missing but
 * members exist, synthesizes a default row so the caller can render
 * cleanly (groups born before S260 didn't get a BookingGroup row).
 */
export async function getBookingGroup(groupKey) {
  const key = normaliseGroupKey(groupKey);
  if (!key) return null;
  const [meta, members] = await Promise.all([
    db.bookingGroup.findUnique({ where: { groupKey: key } }),
    db.booking.findMany({
      where: { groupKey: key },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, bookingNo: true, kelas: true, paxCount: true, status: true,
        totalAmount: true, paidAmount: true, currency: true, createdAt: true,
        paket: { select: { id: true, slug: true, title: true, departureDate: true } },
        jemaah: { select: { id: true, fullName: true, phone: true, email: true } },
        agent: { select: { id: true, slug: true, displayName: true } },
      },
    }),
  ]);
  if (!meta && members.length === 0) return null;
  return {
    groupKey: key,
    label: meta?.label ?? null,
    notes: meta?.notes ?? null,
    createdAt: meta?.createdAt ?? members[0]?.createdAt ?? null,
    members,
  };
}

/**
 * Stage 260 — set the group label/notes. Upserts the BookingGroup row.
 * Skip-audit-on-no-op when neither field actually changes.
 *
 *   - `label`: trimmed, capped at 120 chars; empty string → null.
 *   - `notes`: trimmed, capped at 4000 chars; empty string → null.
 *
 * Either field can be omitted (`undefined`) to preserve its current
 * value — same three-state preprocessor convention as the rest of the
 * codebase. Explicit empty string clears.
 */
export async function setGroupLabel({ req, actor, groupKey, label, notes }) {
  const key = normaliseGroupKey(groupKey);
  if (!key) throw new HttpError(400, 'Format groupKey tidak valid', 'BAD_GROUP_KEY');

  const before = await db.bookingGroup.findUnique({ where: { groupKey: key } });

  function clean(v, max) {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    return String(v).trim().slice(0, max) || null;
  }
  const nextLabel = clean(label, 120);
  const nextNotes = clean(notes, 4000);

  const labelChanged = nextLabel !== undefined && nextLabel !== (before?.label ?? null);
  const notesChanged = nextNotes !== undefined && nextNotes !== (before?.notes ?? null);
  if (before && !labelChanged && !notesChanged) {
    return { updated: false, group: before };
  }

  const data = {};
  if (labelChanged) data.label = nextLabel;
  if (notesChanged) data.notes = nextNotes;

  const after = await db.bookingGroup.upsert({
    where: { groupKey: key },
    update: data,
    create: { groupKey: key, label: nextLabel ?? null, notes: nextNotes ?? null },
  });

  await audit({
    req, actor,
    action: before ? 'UPDATE' : 'CREATE',
    entity: 'BookingGroup', entityId: key,
    before: before ? { label: before.label, notes: before.notes } : null,
    after: { label: after.label, notes: after.notes },
  });

  return { updated: true, group: after };
}
