// Stage 222 — per-paket WhatsApp group invite URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket } from './_helpers.js';
import { PaketSchema } from '../src/services/paketAdmin.js';

const requiredFields = (overrides = {}) => ({
  slug: 'p-' + Math.random().toString(36).slice(2, 8),
  title: 'Test',
  departureDate: '2027-01-01',
  returnDate: '2027-01-10',
  durationDays: 10,
  kursiTotal: 10,
  ...overrides,
});

test('PaketSchema: accepts valid waGroupUrl', () => {
  const r = PaketSchema.parse(requiredFields({ waGroupUrl: 'https://chat.whatsapp.com/abc123' }));
  assert.equal(r.waGroupUrl, 'https://chat.whatsapp.com/abc123');
});

test('PaketSchema: rejects non-URL waGroupUrl', () => {
  assert.throws(() => PaketSchema.parse(requiredFields({ waGroupUrl: 'not-a-url' })));
});

test('PaketSchema: empty waGroupUrl → null (explicit clear)', () => {
  const r = PaketSchema.parse(requiredFields({ waGroupUrl: '' }));
  assert.equal(r.waGroupUrl, null);
});

test('PaketSchema: omitted waGroupUrl → undefined (no change signal)', () => {
  const r = PaketSchema.parse(requiredFields());
  assert.equal(r.waGroupUrl, undefined);
});

test('Paket.waGroupUrl column persists', async (t) => {
  const tag = makeTag('s222-persist');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { waGroupUrl: 'https://chat.whatsapp.com/grouptest' },
  });
  const fresh = await db.paket.findUnique({ where: { id: paket.id }, select: { waGroupUrl: true } });
  assert.equal(fresh.waGroupUrl, 'https://chat.whatsapp.com/grouptest');
});

test('Paket.waGroupUrl is nullable (back-compat for existing rows)', async (t) => {
  const tag = makeTag('s222-null');
  const paket = await tempPaket(t, tag);
  const fresh = await db.paket.findUnique({ where: { id: paket.id }, select: { waGroupUrl: true } });
  assert.equal(fresh.waGroupUrl, null);
});

test('getAssignedManifest: includes waGroupUrl in returned paket', async (t) => {
  const { tempMuthawwif } = await import('./_helpers.js');
  const { getAssignedManifest } = await import('../src/services/crewPortal.js');
  const tag = makeTag('s222-crew');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paket.update({ where: { id: paket.id }, data: { waGroupUrl: 'https://chat.whatsapp.com/crewlink' } });
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });

  const r = await getAssignedManifest({ userId: crew.id, slug: paket.slug });
  assert.equal(r.waGroupUrl, 'https://chat.whatsapp.com/crewlink');
});

test('getMyBooking: includes waGroupUrl in paket select', async (t) => {
  const { tempJemaah, tempBooking } = await import('./_helpers.js');
  const { getMyBooking } = await import('../src/services/jemaahPortal.js');
  const tag = makeTag('s222-jemaah');
  const u = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paket.update({ where: { id: paket.id }, data: { waGroupUrl: 'https://chat.whatsapp.com/jemaahlink' } });
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id, jemaahUserId: u.id });

  const result = await getMyBooking(u.id, b.id);
  assert.equal(result.paket.waGroupUrl, 'https://chat.whatsapp.com/jemaahlink');
});
