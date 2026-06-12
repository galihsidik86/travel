// Stage 256 — booking clone for new jemaah.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { cloneBooking, generateGroupKey } from '../src/services/bookingClone.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

test('generateGroupKey: returns G- prefixed unique string', () => {
  const a = generateGroupKey();
  const b = generateGroupKey();
  assert.match(a, /^G-[A-F0-9]{6}$/);
  assert.notEqual(a, b);
});

test('cloneBooking: 400 when newJemaah name missing', async () => {
  await assert.rejects(
    () => cloneBooking({
      req: fakeReq, actor: adminActor,
      sourceBookingId: 'x',
      newJemaah: { phone: '+62811' },
    }),
    (err) => err.code === 'JEMAAH_NAME_REQUIRED' && err.status === 400,
  );
});

test('cloneBooking: 400 when phone missing', async () => {
  await assert.rejects(
    () => cloneBooking({
      req: fakeReq, actor: adminActor,
      sourceBookingId: 'x',
      newJemaah: { fullName: 'Valid Name' },
    }),
    (err) => err.code === 'JEMAAH_PHONE_REQUIRED' && err.status === 400,
  );
});

test('cloneBooking: 404 on unknown source', async () => {
  await assert.rejects(
    () => cloneBooking({
      req: fakeReq, actor: adminActor,
      sourceBookingId: 'no-such',
      newJemaah: { fullName: 'Test', phone: '+62811' },
    }),
    (err) => err.code === 'BOOKING_NOT_FOUND' && err.status === 404,
  );
});

test('cloneBooking: refuses on CANCELLED source', async (t) => {
  const tag = makeTag('s256-cancel');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-C`, paketId: paket.id, jemaahId: u.jemaah.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '500', paidAmount: '0',
      status: 'CANCELLED',
    },
  });
  t.after(async () => { await db.booking.deleteMany({ where: { id: b.id } }); });

  await assert.rejects(
    () => cloneBooking({
      req: fakeReq, actor: adminActor,
      sourceBookingId: b.id,
      newJemaah: { fullName: 'Test', phone: '+62811' },
    }),
    (err) => err.code === 'SOURCE_CLOSED' && err.status === 409,
  );
});

test('cloneBooking: creates new booking on same paket with new jemaah', async (t) => {
  const tag = makeTag('s256-clone');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const source = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  // Cleanup the new profile & clone booking
  t.after(async () => {
    const clones = await db.booking.findMany({ where: { paketId: paket.id, id: { not: source.id } } });
    for (const c of clones) {
      await db.jemaahProfile.deleteMany({ where: { id: c.jemaahId } });
    }
  });

  const result = await cloneBooking({
    req: fakeReq, actor: adminActor,
    sourceBookingId: source.id,
    newJemaah: { fullName: 'Ahmad Junior', phone: '+62 822 1234 5678' },
  });
  assert.ok(result.booking.id !== source.id);
  assert.equal(result.booking.paketId, paket.id);
  assert.equal(result.booking.kelas, source.kelas);
  assert.equal(result.booking.status, 'PENDING');
  assert.equal(result.booking.paidAmount.toString(), '0');
  assert.equal(result.groupCreated, true);
  assert.match(result.groupKey, /^G-/);
});

test('cloneBooking: source booking gets stamped with new groupKey when groupless', async (t) => {
  const tag = makeTag('s256-stamp');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const source = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  t.after(async () => {
    const clones = await db.booking.findMany({ where: { paketId: paket.id, id: { not: source.id } } });
    for (const c of clones) {
      await db.jemaahProfile.deleteMany({ where: { id: c.jemaahId } });
    }
  });

  const result = await cloneBooking({
    req: fakeReq, actor: adminActor,
    sourceBookingId: source.id,
    newJemaah: { fullName: 'Ahmad Junior', phone: '+62811' },
  });
  // Both should share the groupKey now
  const updatedSource = await db.booking.findUnique({ where: { id: source.id }, select: { groupKey: true } });
  assert.equal(updatedSource.groupKey, result.groupKey);
});

test('cloneBooking: existing groupKey is inherited (not regenerated)', async (t) => {
  const tag = makeTag('s256-inherit');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const source = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.booking.update({ where: { id: source.id }, data: { groupKey: 'G-EXIST' } });
  t.after(async () => {
    const clones = await db.booking.findMany({ where: { paketId: paket.id, id: { not: source.id } } });
    for (const c of clones) {
      await db.jemaahProfile.deleteMany({ where: { id: c.jemaahId } });
    }
  });

  const result = await cloneBooking({
    req: fakeReq, actor: adminActor,
    sourceBookingId: source.id,
    newJemaah: { fullName: 'Ahmad Junior', phone: '+62811' },
  });
  assert.equal(result.groupKey, 'G-EXIST');
  assert.equal(result.groupCreated, false);
});

test('cloneBooking: paxCount override stored', async (t) => {
  const tag = makeTag('s256-pax');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  // Source has paxCount=1 (default)
  const source = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  t.after(async () => {
    const clones = await db.booking.findMany({ where: { paketId: paket.id, id: { not: source.id } } });
    for (const c of clones) {
      await db.jemaahProfile.deleteMany({ where: { id: c.jemaahId } });
    }
  });

  const result = await cloneBooking({
    req: fakeReq, actor: adminActor,
    sourceBookingId: source.id,
    newJemaah: { fullName: 'Ahmad Junior', phone: '+62811' },
    paxCount: 3,
  });
  assert.equal(result.booking.paxCount, 3);
});

test('cloneBooking: refuses when not enough seats remain', async (t) => {
  const tag = makeTag('s256-seats');
  const paket = await tempPaket(t, tag);
  // Bump kursiTerisi to leave only 1 seat
  await db.paket.update({ where: { id: paket.id }, data: { kursiTerisi: 9, kursiTotal: 10 } });
  const u = await tempJemaah(t, tag);
  const source = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });

  await assert.rejects(
    () => cloneBooking({
      req: fakeReq, actor: adminActor,
      sourceBookingId: source.id,
      newJemaah: { fullName: 'Junior', phone: '+62811' },
      paxCount: 5,
    }),
    (err) => err.code === 'NOT_ENOUGH_SEATS' && err.status === 409,
  );
});

test('cloneBooking: clone notes start with [Cloned from <bookingNo>]', async (t) => {
  const tag = makeTag('s256-notes');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const source = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  await db.booking.update({ where: { id: source.id }, data: { notes: 'Catatan asli' } });
  t.after(async () => {
    const clones = await db.booking.findMany({ where: { paketId: paket.id, id: { not: source.id } } });
    for (const c of clones) {
      await db.jemaahProfile.deleteMany({ where: { id: c.jemaahId } });
    }
  });

  const result = await cloneBooking({
    req: fakeReq, actor: adminActor,
    sourceBookingId: source.id,
    newJemaah: { fullName: 'Junior', phone: '+62811' },
    notesPrefix: 'Anak Pak Ahmad',
  });
  const cloneNotes = await db.booking.findUnique({ where: { id: result.booking.id }, select: { notes: true } });
  assert.match(cloneNotes.notes, /^\[Cloned from RP-/);
  assert.match(cloneNotes.notes, /Anak Pak Ahmad/);
  assert.match(cloneNotes.notes, /Catatan asli/);
});

test('cloneBooking: writes audit row with clonedFromBookingId', async (t) => {
  const tag = makeTag('s256-audit');
  const paket = await tempPaket(t, tag);
  const u = await tempJemaah(t, tag);
  const source = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  t.after(async () => {
    const clones = await db.booking.findMany({ where: { paketId: paket.id, id: { not: source.id } } });
    for (const c of clones) {
      await db.jemaahProfile.deleteMany({ where: { id: c.jemaahId } });
    }
  });

  const result = await cloneBooking({
    req: fakeReq, actor: adminActor,
    sourceBookingId: source.id,
    newJemaah: { fullName: 'Junior', phone: '+62811' },
  });
  const audits = await db.auditLog.findMany({
    where: { entity: 'Booking', entityId: result.booking.id, action: 'CREATE' },
    take: 1,
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].after.clonedFromBookingId, source.id);
  assert.equal(audits[0].after.clonedFromBookingNo, source.bookingNo);
});

test('cloneBooking: paket kursiTerisi incremented by new paxCount', async (t) => {
  const tag = makeTag('s256-kursi');
  const paket = await tempPaket(t, tag);
  await db.paket.update({ where: { id: paket.id }, data: { kursiTerisi: 1 } });
  const u = await tempJemaah(t, tag);
  const source = await tempBooking({ paket, jemaahProfileId: u.jemaah.id });
  t.after(async () => {
    const clones = await db.booking.findMany({ where: { paketId: paket.id, id: { not: source.id } } });
    for (const c of clones) {
      await db.jemaahProfile.deleteMany({ where: { id: c.jemaahId } });
    }
  });

  await cloneBooking({
    req: fakeReq, actor: adminActor,
    sourceBookingId: source.id,
    newJemaah: { fullName: 'Junior', phone: '+62811' },
    paxCount: 2,
  });
  const updated = await db.paket.findUnique({ where: { id: paket.id }, select: { kursiTerisi: true } });
  assert.equal(updated.kursiTerisi, 3); // 1 + 2 new
});
