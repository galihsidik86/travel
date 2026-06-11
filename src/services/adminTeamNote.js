// Stage 179 — single-row shared note for the admin team. Editable
// by 4 admin roles (OWNER/SUPERADMIN/MANAJER_OPS/KASIR); visible to
// all admin sessions on /admin overview.
//
// Pattern: classic single-row config. We use `id='singleton'` so
// we can always upsert by a known PK rather than tracking row ids.
//
// No history table — the audit log captures every save with the
// `before`/`after` body diff if a later operator wants to grep
// "who changed it last week and to what".

import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const SINGLETON_ID = 'singleton';
const MAX_LEN = 4000;

export async function getAdminTeamNote() {
  const row = await db.adminTeamNote.findUnique({ where: { id: SINGLETON_ID } });
  return row || null;
}

export async function updateAdminTeamNote({ req, actor, body }) {
  // Normalise input: trim, empty → null (clear). Cap length defensively.
  let next = null;
  if (body != null) {
    const s = String(body).trim();
    if (s.length > MAX_LEN) {
      throw new HttpError(400, `Catatan maksimal ${MAX_LEN} karakter`, 'NOTE_TOO_LONG');
    }
    next = s === '' ? null : s;
  }
  const before = await db.adminTeamNote.findUnique({ where: { id: SINGLETON_ID } });
  // Skip-audit-on-no-op (mirrors updateBookingNotes convention)
  if ((before?.body ?? null) === next) {
    return { updated: false, row: before };
  }

  const row = await db.adminTeamNote.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID, body: next,
      updatedById: actor?.id || null,
      updatedByEmail: actor?.email || null,
    },
    update: {
      body: next,
      updatedById: actor?.id || null,
      updatedByEmail: actor?.email || null,
    },
  });

  await audit({
    req, actor,
    action: 'UPDATE', entity: 'AdminTeamNote', entityId: SINGLETON_ID,
    before: { body: before?.body ?? null, updatedByEmail: before?.updatedByEmail ?? null },
    after: { body: row.body, updatedByEmail: row.updatedByEmail },
  });
  return { updated: true, row };
}

export { MAX_LEN as ADMIN_TEAM_NOTE_MAX_LEN };
