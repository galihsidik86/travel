// Stage 180 — reusable note templates for the booking notes textarea.
// Admin maintains a small list (lansia, mahram, diet khusus, etc); the
// notes edit surface gets a quick-insert dropdown above the textarea
// so admin can append common phrases without retyping.
//
// CRUD is admin-only (OWNER+SUPERADMIN). All 4 admin VIEW roles can
// READ the list so the dropdown surfaces on `/admin/bookings/:id` for
// MANAJER_OPS + KASIR too.

import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export const NoteTemplateSchema = z.object({
  name: z.string().min(2, 'Nama minimal 2 karakter').max(80),
  body: z.string().min(1, 'Body wajib diisi').max(2000),
  sortOrder: z.preprocess(
    (v) => (v === '' || v == null ? 0 : Number(v)),
    z.number().int().min(0).max(9999).default(0),
  ),
});

export async function listNoteTemplates() {
  return db.bookingNoteTemplate.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export async function createNoteTemplate({ req, actor, input }) {
  const data = NoteTemplateSchema.parse(input);
  try {
    const row = await db.bookingNoteTemplate.create({ data });
    await audit({
      req, actor, action: 'CREATE',
      entity: 'BookingNoteTemplate', entityId: row.id,
      after: { name: row.name, body: row.body, sortOrder: row.sortOrder },
    });
    return row;
  } catch (err) {
    if (err?.code === 'P2002') {
      throw new HttpError(409, `Template dengan nama "${data.name}" sudah ada`, 'TEMPLATE_NAME_TAKEN');
    }
    throw err;
  }
}

export async function updateNoteTemplate({ req, actor, id, input }) {
  const before = await db.bookingNoteTemplate.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'Template tidak ditemukan', 'TEMPLATE_NOT_FOUND');
  const data = NoteTemplateSchema.parse(input);
  try {
    const row = await db.bookingNoteTemplate.update({ where: { id }, data });
    await audit({
      req, actor, action: 'UPDATE',
      entity: 'BookingNoteTemplate', entityId: id,
      before: { name: before.name, body: before.body, sortOrder: before.sortOrder },
      after:  { name: row.name,    body: row.body,    sortOrder: row.sortOrder },
    });
    return row;
  } catch (err) {
    if (err?.code === 'P2002') {
      throw new HttpError(409, `Template dengan nama "${data.name}" sudah ada`, 'TEMPLATE_NAME_TAKEN');
    }
    throw err;
  }
}

export async function deleteNoteTemplate({ req, actor, id }) {
  const before = await db.bookingNoteTemplate.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'Template tidak ditemukan', 'TEMPLATE_NOT_FOUND');
  await db.bookingNoteTemplate.delete({ where: { id } });
  await audit({
    req, actor, action: 'DELETE',
    entity: 'BookingNoteTemplate', entityId: id,
    before: { name: before.name, body: before.body },
  });
  return { id, name: before.name };
}
