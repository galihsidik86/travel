// Stage 245 — crew cross-paket ICE contact book.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempMuthawwif, tempBooking } from './_helpers.js';
import { getCrewContactBook } from '../src/services/crewContactBook.js';

async function assign(paket, crew) {
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
}

test('getCrewContactBook: missing userId → empty shape', async () => {
  const r = await getCrewContactBook({});
  assert.deepEqual(r.rows, []);
  assert.equal(r.pagination.total, 0);
});

test('getCrewContactBook: unassigned crew → empty', async (t) => {
  const tag = makeTag('s245-empty');
  const crew = await tempMuthawwif(t, tag);
  const r = await getCrewContactBook({ userId: crew.id });
  assert.equal(r.rows.length, 0);
  assert.equal(r.pagination.total, 0);
});

test('getCrewContactBook: lists jemaah across assigned paket', async (t) => {
  const tag = makeTag('s245-list');
  const crew = await tempMuthawwif(t, tag);
  const paketA = await tempPaket(t, tag + '-a');
  const paketB = await tempPaket(t, tag + '-b');
  await assign(paketA, crew);
  await assign(paketB, crew);
  const jA = await tempJemaah(t, tag + '-a');
  const jB = await tempJemaah(t, tag + '-b');
  await tempBooking({ paket: paketA, jemaahProfileId: jA.jemaah.id });
  await tempBooking({ paket: paketB, jemaahProfileId: jB.jemaah.id });

  const r = await getCrewContactBook({ userId: crew.id });
  assert.equal(r.rows.length, 2);
  assert.equal(r.pagination.total, 2);
});

test('getCrewContactBook: NOT visible to non-assigned crew', async (t) => {
  const tag = makeTag('s245-isolate');
  const crewA = await tempMuthawwif(t, tag + '-a');
  const crewB = await tempMuthawwif(t, tag + '-b');
  const paket = await tempPaket(t, tag);
  await assign(paket, crewA);
  // crewB is NOT assigned
  const j = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const r = await getCrewContactBook({ userId: crewB.id });
  assert.equal(r.rows.length, 0);
});

test('getCrewContactBook: search by jemaah name (substring, case-insensitive at DB level)', async (t) => {
  const tag = makeTag('s245-search');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const j = await tempJemaah(t, tag);
  await db.jemaahProfile.update({ where: { id: j.jemaah.id }, data: { fullName: 'Ahmad Budiman' } });
  await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const r = await getCrewContactBook({ userId: crew.id, q: 'Budiman' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].jemaah.fullName, 'Ahmad Budiman');
});

test('getCrewContactBook: search by phone substring', async (t) => {
  const tag = makeTag('s245-phone');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const j = await tempJemaah(t, tag);
  await db.jemaahProfile.update({ where: { id: j.jemaah.id }, data: { phone: '+6285511223344' } });
  await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const r = await getCrewContactBook({ userId: crew.id, q: '8551' });
  assert.equal(r.rows.length, 1);
});

test('getCrewContactBook: CANCELLED bookings excluded', async (t) => {
  const tag = makeTag('s245-cancel');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const j = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: j.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
    },
  });

  const r = await getCrewContactBook({ userId: crew.id });
  assert.equal(r.rows.length, 0);
});

test('getCrewContactBook: ARCHIVED paket excluded', async (t) => {
  const tag = makeTag('s245-archived');
  const crew = await tempMuthawwif(t, tag);
  const dep = new Date(Date.now() + 30 * 86_400_000);
  const archived = await db.paket.create({
    data: {
      slug: tag, title: 'X', departureDate: dep,
      returnDate: new Date(dep.getTime() + 10 * 86_400_000),
      durationDays: 10, inclusions: [], exclusions: [],
      kursiTotal: 10, status: 'ARCHIVED',
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { paketId: archived.id } });
    await db.paketCrew.deleteMany({ where: { paketId: archived.id } });
    await db.paket.deleteMany({ where: { id: archived.id } });
  });
  await assign(archived, crew);
  const j = await tempJemaah(t, tag);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}`, paketId: archived.id, jemaahId: j.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'PENDING',
    },
  });

  const r = await getCrewContactBook({ userId: crew.id });
  assert.equal(r.rows.length, 0);
});

test('getCrewContactBook: pagination caps pageSize', async () => {
  const r = await getCrewContactBook({ userId: 'no-such', pageSize: 500 });
  assert.equal(r.pagination.pageSize, 100);
});

test('getCrewContactBook: pagination floors page at 1', async () => {
  const r = await getCrewContactBook({ userId: 'no-such', page: -5 });
  assert.equal(r.pagination.page, 1);
});

test('getCrewContactBook: emergencyContact + passportNo included in returned shape', async (t) => {
  const tag = makeTag('s245-ice');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const j = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: j.jemaah.id },
    data: { emergencyContact: 'Istri · 0812-AAAA', passportNo: 'A1234567' },
  });
  await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const r = await getCrewContactBook({ userId: crew.id });
  assert.equal(r.rows[0].jemaah.emergencyContact, 'Istri · 0812-AAAA');
  assert.equal(r.rows[0].jemaah.passportNo, 'A1234567');
});

test('getCrewContactBook: NO money fields in returned shape', async (t) => {
  const tag = makeTag('s245-nomoney');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await assign(paket, crew);
  const j = await tempJemaah(t, tag);
  await tempBooking({ paket, jemaahProfileId: j.jemaah.id });

  const r = await getCrewContactBook({ userId: crew.id });
  assert.equal(r.rows[0].totalAmount, undefined);
  assert.equal(r.rows[0].paidAmount, undefined);
});
