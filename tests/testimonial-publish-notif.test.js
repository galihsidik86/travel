// Stage 70 — testimonial published notif.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, fakeReq } from './_helpers.js';
import { createTestimonial, updateTestimonial } from '../src/services/testimonialAdmin.js';

const systemActor = { email: 'test', role: 'OWNER' };

test('DRAFT → PUBLISHED fires notif when submittedByUserId is set', async (t) => {
  const tag = makeTag('tpn-publish');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);

  // Simulate jemaah-side submit by manually creating a DRAFT with submittedByUserId
  const tt = await db.testimonial.create({
    data: {
      paketId: paket.id,
      jemaahName: 'Pak Hasan',
      body: 'Pelayanan sangat baik dan ramah, jemaah dibantu oleh muthawif yang sabar.',
      rating: 5,
      status: 'DRAFT',
      submittedByUserId: jem.id,
    },
  });
  t.after(async () => {
    await db.testimonial.deleteMany({ where: { id: tt.id } });
    await db.notification.deleteMany({ where: { recipientEmail: jem.email } });
  });

  // Admin flips to PUBLISHED
  await updateTestimonial({
    req: fakeReq, actor: systemActor, id: tt.id,
    input: {
      paketId: paket.id,
      jemaahName: 'Pak Hasan',
      body: tt.body,
      rating: 5,
      status: 'PUBLISHED',
      sortOrder: 0,
    },
  });

  // Notif should be enqueued for the jemaah
  const notif = await db.notification.findFirst({
    where: { type: 'TESTIMONIAL_PUBLISHED', recipientEmail: jem.email },
    select: { subject: true, body: true, recipientUserId: true, relatedEntity: true },
  });
  assert.ok(notif, 'TESTIMONIAL_PUBLISHED row must be enqueued');
  assert.match(notif.subject, /tampil/i);
  assert.equal(notif.recipientUserId, jem.id, 'recipientUserId set so jemaah inbox + unread badge work');
  assert.equal(notif.relatedEntity, 'Testimonial');
});

test('admin-authored testimonial (no submittedByUserId) skips notif on publish', async (t) => {
  const tag = makeTag('tpn-admin');
  const paket = await tempPaket(t, tag);

  const tt = await createTestimonial({
    req: fakeReq, actor: systemActor,
    input: {
      paketId: paket.id,
      jemaahName: 'Admin Wrote This',
      body: 'this body is admin-authored and meets the minimum length requirement',
      rating: 5, sortOrder: 0,
    },
  });
  t.after(async () => { await db.testimonial.deleteMany({ where: { id: tt.id } }); });

  await updateTestimonial({
    req: fakeReq, actor: systemActor, id: tt.id,
    input: {
      paketId: paket.id,
      jemaahName: 'Admin Wrote This',
      body: tt.body,
      rating: 5, status: 'PUBLISHED', sortOrder: 0,
    },
  });

  const notifs = await db.notification.findMany({
    where: { type: 'TESTIMONIAL_PUBLISHED', relatedEntityId: tt.id },
  });
  assert.equal(notifs.length, 0, 'admin-authored testimonial must NOT trigger notif');
});

test('PUBLISHED → DRAFT (unpublish) does NOT fire notif', async (t) => {
  const tag = makeTag('tpn-unpub');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const tt = await db.testimonial.create({
    data: {
      paketId: paket.id,
      jemaahName: 'Bu Siti',
      body: 'this testimonial starts published and gets unpublished by admin',
      rating: 5, status: 'PUBLISHED', submittedByUserId: jem.id,
    },
  });
  t.after(async () => {
    await db.testimonial.deleteMany({ where: { id: tt.id } });
    await db.notification.deleteMany({ where: { recipientEmail: jem.email } });
  });

  await updateTestimonial({
    req: fakeReq, actor: systemActor, id: tt.id,
    input: {
      paketId: paket.id,
      jemaahName: 'Bu Siti',
      body: tt.body,
      rating: 5, status: 'DRAFT', sortOrder: 0,
    },
  });

  const notifs = await db.notification.findMany({
    where: { type: 'TESTIMONIAL_PUBLISHED', recipientEmail: jem.email },
  });
  assert.equal(notifs.length, 0, 'unpublish must NOT fire the publish notif');
});
