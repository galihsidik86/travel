// Stage 63 — testimonial admin service. Simple CRUD wrapping the
// Testimonial model. Validation via zod; audit trail via the standard
// audit() helper.
import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

const optStr = z.preprocess((v) => v === '' ? null : v, z.string().max(255).nullable().optional());

export const TestimonialSchema = z.object({
  paketId:    optStr,
  jemaahName: z.string().min(2, 'Nama jemaah minimal 2 karakter').max(120),
  jemaahCity: optStr,
  body:       z.string().min(10, 'Isi testimonial minimal 10 karakter').max(2000),
  rating:     z.preprocess((v) => Number(v), z.number().int().min(1).max(5)),
  photoUrl:   optStr,
  status:     z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
  sortOrder:  z.preprocess((v) => Number(v) || 0, z.number().int().min(-1000).max(1000)),
});

export async function listTestimonials({ status = null } = {}) {
  return db.testimonial.findMany({
    where: status ? { status } : {},
    orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
    include: { paket: { select: { slug: true, title: true } } },
  });
}

export async function getTestimonialById(id) {
  return db.testimonial.findUnique({
    where: { id },
    include: { paket: { select: { slug: true, title: true } } },
  });
}

export async function createTestimonial({ req, actor, input }) {
  const data = TestimonialSchema.parse(input);
  // Validate paketId (if set) actually exists
  if (data.paketId) {
    const p = await db.paket.findUnique({ where: { id: data.paketId }, select: { id: true } });
    if (!p) throw new HttpError(400, 'Paket tidak ditemukan', 'INVALID_PAKET');
  }
  const t = await db.testimonial.create({ data });
  await audit({
    req, actor,
    action: 'CREATE', entity: 'Testimonial', entityId: t.id,
    after: { jemaahName: t.jemaahName, status: t.status, paketId: t.paketId },
  });
  return t;
}

export async function updateTestimonial({ req, actor, id, input }) {
  const data = TestimonialSchema.parse(input);
  if (data.paketId) {
    const p = await db.paket.findUnique({ where: { id: data.paketId }, select: { id: true } });
    if (!p) throw new HttpError(400, 'Paket tidak ditemukan', 'INVALID_PAKET');
  }
  const before = await db.testimonial.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'Testimonial tidak ditemukan', 'TESTIMONIAL_NOT_FOUND');
  const t = await db.testimonial.update({ where: { id }, data });
  await audit({
    req, actor,
    action: 'UPDATE', entity: 'Testimonial', entityId: id,
    before: { status: before.status, sortOrder: before.sortOrder },
    after: { status: t.status, sortOrder: t.sortOrder },
  });
  return t;
}

export async function deleteTestimonial({ req, actor, id }) {
  const before = await db.testimonial.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'Testimonial tidak ditemukan', 'TESTIMONIAL_NOT_FOUND');
  await db.testimonial.delete({ where: { id } });
  await audit({
    req, actor,
    action: 'DELETE', entity: 'Testimonial', entityId: id,
    before: { jemaahName: before.jemaahName, status: before.status },
  });
}

/**
 * Stage 63 — public-facing fetch for /p/:slug. Returns PUBLISHED
 * testimonials tied to this paket OR generic (paketId null) — admins
 * get both surfaces from one editor.
 */
export async function getPublishedTestimonialsForPaket(paketId) {
  if (!paketId) return [];
  return db.testimonial.findMany({
    where: {
      status: 'PUBLISHED',
      OR: [{ paketId }, { paketId: null }],
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true, jemaahName: true, jemaahCity: true,
      body: true, rating: true, photoUrl: true,
    },
  });
}
