// Stage 190 — per-paket FAQ. Admin curates Q&A pairs per paket;
// renders as collapsible accordion below the hero on /p/:slug.
//
// All FAQs for a paket loaded together (small N, no pagination).
// `sortOrder asc, createdAt asc` ordering — admin controls priority,
// ties broken by creation time.

import { z } from 'zod';
import { db } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';

export const FaqSchema = z.object({
  question: z.string().min(3, 'Pertanyaan minimal 3 karakter').max(200),
  answer: z.string().min(3, 'Jawaban minimal 3 karakter').max(5000),
  sortOrder: z.preprocess(
    (v) => (v === '' || v == null ? 0 : Number(v)),
    z.number().int().min(0).max(9999).default(0),
  ),
});

export async function listFaqs(paketId) {
  return db.paketFaq.findMany({
    where: { paketId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function createFaq({ req, actor, paketId, input }) {
  const data = FaqSchema.parse(input);
  // Confirm paket exists — defensive against bad slug-to-id resolution
  const paket = await db.paket.findUnique({
    where: { id: paketId }, select: { id: true, slug: true },
  });
  if (!paket) throw new HttpError(404, 'Paket tidak ditemukan', 'PAKET_NOT_FOUND');
  const row = await db.paketFaq.create({
    data: { paketId, ...data },
  });
  await audit({
    req, actor, action: 'CREATE',
    entity: 'PaketFaq', entityId: row.id,
    after: { paketSlug: paket.slug, question: row.question, sortOrder: row.sortOrder },
  });
  return row;
}

export async function updateFaq({ req, actor, id, input }) {
  const before = await db.paketFaq.findUnique({
    where: { id },
    include: { paket: { select: { slug: true } } },
  });
  if (!before) throw new HttpError(404, 'FAQ tidak ditemukan', 'FAQ_NOT_FOUND');
  const data = FaqSchema.parse(input);
  const row = await db.paketFaq.update({ where: { id }, data });
  await audit({
    req, actor, action: 'UPDATE',
    entity: 'PaketFaq', entityId: id,
    before: { question: before.question, answer: before.answer, sortOrder: before.sortOrder },
    after:  { question: row.question,    answer: row.answer,    sortOrder: row.sortOrder },
  });
  return row;
}

export async function deleteFaq({ req, actor, id }) {
  const before = await db.paketFaq.findUnique({
    where: { id },
    include: { paket: { select: { slug: true } } },
  });
  if (!before) throw new HttpError(404, 'FAQ tidak ditemukan', 'FAQ_NOT_FOUND');
  await db.paketFaq.delete({ where: { id } });
  await audit({
    req, actor, action: 'DELETE',
    entity: 'PaketFaq', entityId: id,
    before: { paketSlug: before.paket?.slug, question: before.question },
  });
  return { id, paketId: before.paketId };
}
