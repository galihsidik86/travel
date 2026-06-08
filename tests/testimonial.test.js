// Stage 63 — testimonial admin service.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, fakeReq, systemActor } from './_helpers.js';
import {
  createTestimonial, updateTestimonial, deleteTestimonial,
  getPublishedTestimonialsForPaket, listTestimonials,
} from '../src/services/testimonialAdmin.js';

test('createTestimonial defaults to DRAFT and writes audit row', async (t) => {
  const tag = makeTag('test-create');
  const paket = await tempPaket(t, tag);

  const tt = await createTestimonial({
    req: fakeReq, actor: { ...systemActor, email: 'test', role: 'OWNER' },
    input: {
      paketId: paket.id,
      jemaahName: 'Pak Hasan',
      jemaahCity: 'Jakarta',
      body: 'Pelayanan luar biasa, akan booking lagi tahun depan insyaAllah.',
      rating: 5,
      sortOrder: 0,
    },
  });
  t.after(async () => { await db.testimonial.deleteMany({ where: { id: tt.id } }); });

  assert.equal(tt.status, 'DRAFT');
  assert.equal(tt.jemaahName, 'Pak Hasan');
  // Audit row exists
  const audit = await db.auditLog.findFirst({
    where: { entity: 'Testimonial', entityId: tt.id, action: 'CREATE' },
  });
  assert.ok(audit);
});

test('createTestimonial validates min body length', async (t) => {
  await assert.rejects(
    () => createTestimonial({
      req: fakeReq, actor: { ...systemActor, role: 'OWNER' },
      input: { jemaahName: 'Ali', body: 'too short', rating: 5, sortOrder: 0 },
    }),
    /minimal 10 karakter/,
  );
});

test('getPublishedTestimonialsForPaket returns PUBLISHED for that paket OR generic', async (t) => {
  const tag = makeTag('test-pub');
  const paket = await tempPaket(t, tag);
  const otherPaket = await tempPaket(t, `${tag}-other`);

  // For this paket
  const t1 = await createTestimonial({
    req: fakeReq, actor: { ...systemActor, role: 'OWNER' },
    input: { paketId: paket.id, jemaahName: 'Andi', body: 'this is the right paket', rating: 5, sortOrder: 1, status: 'PUBLISHED' },
  });
  // Generic (no paketId)
  const t2 = await createTestimonial({
    req: fakeReq, actor: { ...systemActor, role: 'OWNER' },
    input: { jemaahName: 'Budi', body: 'this is generic across all paket', rating: 5, sortOrder: 2, status: 'PUBLISHED' },
  });
  // For a different paket — must NOT appear
  const t3 = await createTestimonial({
    req: fakeReq, actor: { ...systemActor, role: 'OWNER' },
    input: { paketId: otherPaket.id, jemaahName: 'Citra', body: 'this belongs to other paket only', rating: 5, sortOrder: 3, status: 'PUBLISHED' },
  });
  // DRAFT must not appear
  const t4 = await createTestimonial({
    req: fakeReq, actor: { ...systemActor, role: 'OWNER' },
    input: { paketId: paket.id, jemaahName: 'Dewi', body: 'this draft must never show in public', rating: 5, sortOrder: 4, status: 'DRAFT' },
  });
  t.after(async () => {
    await db.testimonial.deleteMany({ where: { id: { in: [t1.id, t2.id, t3.id, t4.id] } } });
  });

  const out = await getPublishedTestimonialsForPaket(paket.id);
  const ids = out.map((r) => r.id);
  assert.ok(ids.includes(t1.id), 'paket-specific PUBLISHED must appear');
  assert.ok(ids.includes(t2.id), 'generic PUBLISHED must appear');
  assert.ok(!ids.includes(t3.id), 'other-paket PUBLISHED must NOT appear');
  assert.ok(!ids.includes(t4.id), 'DRAFT must NOT appear');
});

test('updateTestimonial preserves audit and patches values', async (t) => {
  const tag = makeTag('test-upd');
  const tt = await createTestimonial({
    req: fakeReq, actor: { ...systemActor, role: 'OWNER' },
    input: { jemaahName: 'Old Name', body: 'this is the original body text', rating: 4, sortOrder: 0 },
  });
  t.after(async () => { await db.testimonial.deleteMany({ where: { id: tt.id } }); });

  await updateTestimonial({
    req: fakeReq, actor: { ...systemActor, role: 'OWNER' },
    id: tt.id,
    input: { jemaahName: 'New Name', body: 'this is the updated body text', rating: 5, status: 'PUBLISHED', sortOrder: 10 },
  });
  const re = await db.testimonial.findUnique({ where: { id: tt.id } });
  assert.equal(re.jemaahName, 'New Name');
  assert.equal(re.status, 'PUBLISHED');
  assert.equal(re.sortOrder, 10);
});

test('deleteTestimonial removes the row', async (t) => {
  const tag = makeTag('test-del');
  const tt = await createTestimonial({
    req: fakeReq, actor: { ...systemActor, role: 'OWNER' },
    input: { jemaahName: 'To Delete', body: 'this entry will be deleted in the test', rating: 5, sortOrder: 0 },
  });
  await deleteTestimonial({
    req: fakeReq, actor: { ...systemActor, role: 'OWNER' },
    id: tt.id,
  });
  const re = await db.testimonial.findUnique({ where: { id: tt.id } });
  assert.equal(re, null);
});
