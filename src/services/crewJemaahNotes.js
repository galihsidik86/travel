// Stage 187 — crew per-jemaah notes. Crew adds private notes per
// (paket, jemaah) on the assigned manifest (e.g. "lansia perlu
// pendamping ke kamar"). Admin sees a read-only roll-up on the
// admin manifest view.
//
// Per-crew unique on (paketId, jemaahId, crewUserId) so re-saving
// is an upsert in place rather than stacking rows. Two different
// muthawwif on the same paket can each leave their own note.
//
// Empty body deletes the row (treated as "I want to remove my note").

import { db } from '../lib/db.js';
import { HttpError } from '../middleware/error.js';

const MAX_LEN = 2000;

/**
 * Gate helper — confirms the crew user is assigned to the paket.
 * Returns the paketId when assigned, throws 404 otherwise (mirrors
 * the manifest access pattern — anti-enumeration).
 */
async function loadAssignedPaketIdOrThrow(userId, slug) {
  const row = await db.paketCrew.findFirst({
    where: { userId, paket: { slug, deletedAt: null } },
    select: { paketId: true },
  });
  if (!row) throw new HttpError(404, 'Tidak ditemukan', 'NOT_ASSIGNED');
  return row.paketId;
}

/**
 * Tuple guard — confirms `jemaahId` belongs to a booking on this paket
 * AND that booking isn't cancelled/refunded. Stops crew from leaving
 * notes on jemaah they don't actually have access to.
 */
async function assertJemaahOnPaket(paketId, jemaahId) {
  const b = await db.booking.findFirst({
    where: {
      paketId, jemaahId,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    },
    select: { id: true },
  });
  if (!b) throw new HttpError(404, 'Jemaah tidak ada di paket ini', 'JEMAAH_NOT_ON_PAKET');
}

/**
 * Upsert a note. Empty body deletes any existing note for this
 * (paket, jemaah, crew) triple. Returns the row (or null on delete).
 */
export async function saveCrewJemaahNote({
  userId, paketSlug, jemaahId, body,
}) {
  const paketId = await loadAssignedPaketIdOrThrow(userId, paketSlug);
  await assertJemaahOnPaket(paketId, jemaahId);
  const trimmed = (body == null ? '' : String(body)).trim();
  if (trimmed.length > MAX_LEN) {
    throw new HttpError(400, `Catatan maksimal ${MAX_LEN} karakter`, 'NOTE_TOO_LONG');
  }

  if (trimmed === '') {
    // Empty body → delete any existing note. deleteMany returns count.
    const r = await db.crewJemaahNote.deleteMany({
      where: { paketId, jemaahId, crewUserId: userId },
    });
    return { deleted: r.count > 0, row: null };
  }

  const row = await db.crewJemaahNote.upsert({
    where: {
      paketId_jemaahId_crewUserId: { paketId, jemaahId, crewUserId: userId },
    },
    create: { paketId, jemaahId, crewUserId: userId, body: trimmed },
    update: { body: trimmed },
  });
  return { deleted: false, row };
}

/**
 * Load this crew's own note for a (paket, jemaah) pair. Returns null
 * when nothing saved yet.
 */
export async function getMyCrewJemaahNote({ userId, paketSlug, jemaahId }) {
  const paketId = await loadAssignedPaketIdOrThrow(userId, paketSlug);
  return db.crewJemaahNote.findUnique({
    where: {
      paketId_jemaahId_crewUserId: { paketId, jemaahId, crewUserId: userId },
    },
    select: { id: true, body: true, updatedAt: true },
  });
}

/**
 * Roll-up for the admin manifest view — returns every CrewJemaahNote
 * on this paket grouped by jemaahId. Each note carries the crew
 * author's name so admin sees "from <muthawwif name>".
 *
 * Used by /admin/manifest/:slug and /admin/paket/:slug/attendance —
 * read-only surfaces; admin can't edit a crew's note.
 */
export async function getAllCrewNotesForPaket({ paketId }) {
  const rows = await db.crewJemaahNote.findMany({
    where: { paketId },
    orderBy: [{ jemaahId: 'asc' }, { updatedAt: 'desc' }],
    select: {
      id: true, jemaahId: true, body: true, updatedAt: true,
      crewUser: { select: { fullName: true } },
    },
  });
  // Group by jemaahId so view can render `notes[jemaahId]` directly
  const byJemaah = new Map();
  for (const r of rows) {
    let arr = byJemaah.get(r.jemaahId);
    if (!arr) {
      arr = [];
      byJemaah.set(r.jemaahId, arr);
    }
    arr.push({
      id: r.id, body: r.body, updatedAt: r.updatedAt,
      authorName: r.crewUser?.fullName || 'Crew',
    });
  }
  return Object.fromEntries(byJemaah);
}

export { MAX_LEN as CREW_JEMAAH_NOTE_MAX_LEN };
