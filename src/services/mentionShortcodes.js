// Stage 88 — CRUD for the MentionShortcode table.
//
// Admin pages live under /admin/users/shortcodes (OWNER+SUPERADMIN gate).
// Each shortcut maps a short token (`cs`, `finance`, `ops`) to a single
// staff user. Resolution happens at note-save time via expandShortcodes
// in bookingAdmin.js, so the stored notes carry the full @user.email
// — codes are pure input ergonomics, not a persistence layer.
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const CODE_RE = /^[a-z0-9_-]{1,40}$/;
const STAFF_ROLES = ['OWNER', 'SUPERADMIN', 'MANAJER_OPS', 'KASIR', 'SALES'];

export async function listShortcodes() {
  return db.mentionShortcode.findMany({
    orderBy: { code: 'asc' },
    include: {
      user: { select: { id: true, email: true, fullName: true, role: true, status: true, deletedAt: true } },
      createdBy: { select: { email: true } },
    },
  });
}

export async function createShortcode({ req, actor, code, userId }) {
  const normCode = (code || '').toString().trim().toLowerCase();
  if (!CODE_RE.test(normCode)) {
    throw new HttpError(400, 'Code hanya boleh huruf kecil, angka, _ atau - (max 40 char)', 'BAD_CODE');
  }
  if (!userId) throw new HttpError(400, 'User target wajib diisi', 'USER_REQUIRED');

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true, deletedAt: true, email: true },
  });
  if (!user || user.deletedAt) throw new HttpError(404, 'User tidak ditemukan', 'USER_NOT_FOUND');
  if (!STAFF_ROLES.includes(user.role)) {
    throw new HttpError(400, `Role ${user.role} tidak bisa di-mention via :code (staff only)`, 'NOT_STAFF');
  }

  // Composite unique on `code` — duplicate code is 409, not silent overwrite
  const existing = await db.mentionShortcode.findUnique({ where: { code: normCode }, select: { id: true } });
  if (existing) throw new HttpError(409, `Code ":${normCode}" sudah dipakai`, 'CODE_EXISTS');

  const created = await db.mentionShortcode.create({
    data: {
      code: normCode,
      userId: user.id,
      createdById: actor?.id || null,
    },
  });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'MentionShortcode', entityId: created.id,
    after: { code: normCode, userId: user.id, userEmail: user.email },
  });
  return created;
}

export async function deleteShortcode({ req, actor, id }) {
  const existing = await db.mentionShortcode.findUnique({
    where: { id },
    select: { id: true, code: true, user: { select: { email: true } } },
  });
  if (!existing) throw new HttpError(404, 'Shortcut tidak ditemukan', 'SHORTCUT_NOT_FOUND');
  await db.mentionShortcode.delete({ where: { id } });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'MentionShortcode', entityId: id,
    before: { code: existing.code, userEmail: existing.user?.email || null },
  });
  return { id, code: existing.code };
}

// Staff list for the create form's dropdown.
export async function listStaffForShortcode() {
  return db.user.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      role: { in: STAFF_ROLES },
    },
    orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
    select: { id: true, email: true, fullName: true, role: true },
  });
}

export { CODE_RE, STAFF_ROLES };
