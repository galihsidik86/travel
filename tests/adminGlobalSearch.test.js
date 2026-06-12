// Stage 253 — global admin search service.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking } from './_helpers.js';
import { searchAdminGlobal, MIN_QUERY_LEN } from '../src/services/adminGlobalSearch.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag) {
  const u = await db.user.create({
    data: {
      email: `${tag}-agen@example.test`, passwordHash: await hashPassword('test12345'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
    },
  });
  const profile = await db.agentProfile.create({
    data: { userId: u.id, slug: tag, displayName: `Agen ${tag}`, whatsapp: '+6281122334455' },
  });
  t.after(async () => {
    await db.agentProfile.deleteMany({ where: { id: profile.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });
  return profile;
}

test('searchAdminGlobal: returns empty shape for query below MIN_QUERY_LEN', async () => {
  const r = await searchAdminGlobal({ q: 'a' });
  assert.equal(r.total, 0);
  assert.deepEqual(r.bookings, []);
  assert.deepEqual(r.jemaah, []);
  assert.deepEqual(r.paket, []);
  assert.deepEqual(r.agen, []);
});

test('searchAdminGlobal: MIN_QUERY_LEN constant exposed', () => {
  assert.equal(MIN_QUERY_LEN, 2);
});

test('searchAdminGlobal: finds bookings by bookingNo substring', async (t) => {
  const tag = makeTag('s253-bookno');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  // Use a unique fragment of the bookingNo
  const fragment = b.bookingNo.slice(-8);

  const r = await searchAdminGlobal({ q: fragment });
  const mine = r.bookings.find((row) => row.id === b.id);
  assert.ok(mine);
});

test('searchAdminGlobal: finds bookings by jemaah name', async (t) => {
  const tag = makeTag('s253-jname');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  await db.jemaahProfile.update({ where: { id: u.jemaah.id }, data: { fullName: 'Ahmad Najmuddin' } });
  const b = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  const r = await searchAdminGlobal({ q: 'Najmuddin' });
  const found = r.bookings.find((row) => row.id === b.id);
  assert.ok(found);
});

test('searchAdminGlobal: finds jemaah by NIK', async (t) => {
  const tag = makeTag('s253-nik');
  const u = await tempJemaah(t, tag);
  const unique = '3201' + Math.random().toString().slice(2, 14);
  await db.jemaahProfile.update({ where: { id: u.jemaah.id }, data: { nik: unique } });

  const r = await searchAdminGlobal({ q: unique });
  const found = r.jemaah.find((j) => j.id === u.jemaah.id);
  assert.ok(found);
});

test('searchAdminGlobal: finds paket by slug', async (t) => {
  const tag = makeTag('s253-paket');
  const paket = await tempPaket(t, tag);
  const r = await searchAdminGlobal({ q: tag });
  const found = r.paket.find((p) => p.id === paket.id);
  assert.ok(found);
});

test('searchAdminGlobal: finds agen by displayName', async (t) => {
  const tag = makeTag('s253-agen');
  const profile = await tempAgent(t, tag);
  const r = await searchAdminGlobal({ q: tag });
  const found = r.agen.find((a) => a.id === profile.id);
  assert.ok(found);
});

test('searchAdminGlobal: phone tail match normalises formatting', async (t) => {
  const tag = makeTag('s253-phone');
  const u = await tempJemaah(t, tag);
  await db.jemaahProfile.update({ where: { id: u.jemaah.id }, data: { phone: '+6281155667788' } });

  // Pasted with formatting
  const r = await searchAdminGlobal({ q: '0811 5566 7788' });
  const found = r.jemaah.find((j) => j.id === u.jemaah.id);
  assert.ok(found);
});

test('searchAdminGlobal: ARCHIVED paket excluded? (paket schema lacks ARCHIVED-by-default exclusion in search)', async (t) => {
  // Document existing behaviour: deletedAt:null filter applies; ARCHIVED
  // status is not filtered out (admin might want to find archived paket too).
  const tag = makeTag('s253-arch');
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: 'X', departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ARCHIVED',
    },
  });
  t.after(async () => { await db.paket.deleteMany({ where: { id: paket.id } }); });

  const r = await searchAdminGlobal({ q: tag });
  const found = r.paket.find((p) => p.id === paket.id);
  assert.ok(found, 'ARCHIVED paket should still surface in search');
});

test('searchAdminGlobal: soft-deleted paket excluded', async (t) => {
  const tag = makeTag('s253-deleted');
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: 'X', departureDate: dep, returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ACTIVE',
      deletedAt: new Date(),
    },
  });
  t.after(async () => { await db.paket.deleteMany({ where: { id: paket.id } }); });

  const r = await searchAdminGlobal({ q: tag });
  const found = r.paket.find((p) => p.id === paket.id);
  assert.equal(found, undefined);
});

test('searchAdminGlobal: per-category limit caps at requested limit', async () => {
  // No setup — just verify the limit param caps each category cap
  const r = await searchAdminGlobal({ q: 'demo', limit: 2 });
  assert.ok(r.bookings.length <= 2);
  assert.ok(r.jemaah.length <= 2);
  assert.ok(r.paket.length <= 2);
  assert.ok(r.agen.length <= 2);
});

test('searchAdminGlobal: total = sum of per-category lengths', async (t) => {
  const tag = makeTag('s253-total');
  const u = await tempJemaah(t, tag);
  await db.jemaahProfile.update({ where: { id: u.jemaah.id }, data: { fullName: 'Unique-S253-Total' } });

  const r = await searchAdminGlobal({ q: 'Unique-S253-Total' });
  assert.equal(r.total, r.bookings.length + r.jemaah.length + r.paket.length + r.agen.length);
});
