// Stage 218 — crew sees admin's paket announcements on /crew/paket/:slug.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempMuthawwif } from './_helpers.js';
import { listActiveAnnouncements } from '../src/services/paketAnnouncements.js';

async function seedAnnouncement(paketId, { title = 'Test', body = 'body', publishedAt, expiresAt = null } = {}) {
  return db.paketAnnouncement.create({
    data: {
      paketId, title, body,
      publishedAt: publishedAt || new Date(),
      expiresAt,
    },
  });
}

test('crew route: announcements loader returns currently-published rows', async (t) => {
  const tag = makeTag('s218-active');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
  await seedAnnouncement(paket.id, { title: 'Visa OK' });
  t.after(async () => {
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
  });

  const rows = await listActiveAnnouncements({ paketId: paket.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Visa OK');
});

test('crew route: scheduled-future announcements NOT in the active list', async (t) => {
  const tag = makeTag('s218-future');
  const paket = await tempPaket(t, tag);
  await seedAnnouncement(paket.id, {
    title: 'Next month notice',
    publishedAt: new Date(Date.now() + 30 * 86_400_000),
  });
  t.after(async () => {
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
  });

  const rows = await listActiveAnnouncements({ paketId: paket.id });
  assert.equal(rows.length, 0);
});

test('crew route: expired announcements NOT in the active list', async (t) => {
  const tag = makeTag('s218-expired');
  const paket = await tempPaket(t, tag);
  await seedAnnouncement(paket.id, {
    title: 'Stale notice',
    publishedAt: new Date(Date.now() - 14 * 86_400_000),
    expiresAt: new Date(Date.now() - 1 * 86_400_000),
  });
  t.after(async () => {
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
  });

  const rows = await listActiveAnnouncements({ paketId: paket.id });
  assert.equal(rows.length, 0);
});

test('crew route: multiple announcements ordered publishedAt desc (newest first)', async (t) => {
  const tag = makeTag('s218-order');
  const paket = await tempPaket(t, tag);
  await seedAnnouncement(paket.id, { title: 'Older', publishedAt: new Date(Date.now() - 5 * 86_400_000) });
  await seedAnnouncement(paket.id, { title: 'Newer', publishedAt: new Date(Date.now() - 1 * 86_400_000) });
  t.after(async () => {
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
  });

  const rows = await listActiveAnnouncements({ paketId: paket.id });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Newer');
  assert.equal(rows[1].title, 'Older');
});
