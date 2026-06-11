// Stage 216 — paket announcement EMAIL broadcast to active jemaah.
// Pairs with S192 (admin curates) + S193 (push fan-out).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { __forTesting } from '../src/services/paketAnnouncements.js';

const { emailAnnouncementToJemaah } = __forTesting;

const fakeAnnouncement = (id, title = 'Update Visa') => ({
  id, title, body: 'Visa sudah keluar — silakan ambil di kantor besok.',
});

test('emailAnnouncementToJemaah: empty paket → zero recipients', async (t) => {
  const tag = makeTag('s216-empty');
  const paket = await tempPaket(t, tag);
  const r = await emailAnnouncementToJemaah({
    paket: { id: paket.id, slug: paket.slug, title: paket.title },
    announcement: fakeAnnouncement('a1'),
  });
  assert.equal(r.recipients, 0);
  assert.equal(r.enqueued, 0);
});

test('emailAnnouncementToJemaah: skips jemaah without email', async (t) => {
  const tag = makeTag('s216-noemail');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  // Clear email
  await db.jemaahProfile.update({ where: { id: u.jemaah.id }, data: { email: null } });
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  const r = await emailAnnouncementToJemaah({
    paket: { id: paket.id, slug: paket.slug, title: paket.title },
    announcement: fakeAnnouncement('a1'),
  });
  assert.equal(r.recipients, 0);
});

test('emailAnnouncementToJemaah: enqueues 1 EMAIL per distinct jemaah with email', async (t) => {
  const tag = makeTag('s216-enqueue');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  const ann = fakeAnnouncement(`a-${tag}`, 'Visa Update');
  const r = await emailAnnouncementToJemaah({
    paket: { id: paket.id, slug: paket.slug, title: paket.title },
    announcement: ann,
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: ann.id } });
  });

  assert.equal(r.recipients, 1);
  assert.equal(r.enqueued, 1);

  const rows = await db.notification.findMany({ where: { relatedEntityId: ann.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'GENERIC');
  assert.equal(rows[0].channel, 'EMAIL');
  assert.equal(rows[0].relatedEntity, 'PaketAnnouncement');
  assert.match(rows[0].subject, /Visa Update/);
  assert.match(rows[0].body, /Visa sudah keluar/);
});

test('emailAnnouncementToJemaah: dedupes same jemaah across multiple bookings', async (t) => {
  const tag = makeTag('s216-dedupe');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  // Two bookings, same jemaah (real edge case: rebook after cancel)
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  const ann = fakeAnnouncement(`a-${tag}`);
  const r = await emailAnnouncementToJemaah({
    paket: { id: paket.id, slug: paket.slug, title: paket.title },
    announcement: ann,
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: ann.id } });
  });

  assert.equal(r.recipients, 1, 'one email per jemaah, not per booking');
  assert.equal(r.enqueued, 1);
});

test('emailAnnouncementToJemaah: CANCELLED/REFUNDED bookings excluded', async (t) => {
  const tag = makeTag('s216-cancel');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: u.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
    },
  });

  const ann = fakeAnnouncement(`a-${tag}`);
  const r = await emailAnnouncementToJemaah({
    paket: { id: paket.id, slug: paket.slug, title: paket.title },
    announcement: ann,
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: ann.id } });
  });

  assert.equal(r.recipients, 0);
});

test('emailAnnouncementToJemaah: recipientUserId set on linked bookings', async (t) => {
  const tag = makeTag('s216-userid');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  // Link booking to user (registered jemaah)
  await tempBooking({ paket, jemaahProfileId: u.jemaah.id, jemaahUserId: u.id });

  const ann = fakeAnnouncement(`a-${tag}`);
  const r = await emailAnnouncementToJemaah({
    paket: { id: paket.id, slug: paket.slug, title: paket.title },
    announcement: ann,
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: ann.id } });
  });

  assert.equal(r.enqueued, 1);
  const row = await db.notification.findFirst({ where: { relatedEntityId: ann.id } });
  assert.equal(row.recipientUserId, u.id, 'so /saya/notifications shows it');
});
