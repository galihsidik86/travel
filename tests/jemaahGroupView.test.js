// Stage 264 — jemaah-side group view (privacy-sanitized).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import { getJemaahGroupView, firstName } from '../src/services/jemaahGroupView.js';
import { setBookingGroupKey, setGroupLabel } from '../src/services/bookingGroup.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

// ── firstName helper ─────────────────────────────────────────────

test('firstName: returns first token of plain name', () => {
  assert.equal(firstName('Ahmad Wijaya'), 'Ahmad');
});

test('firstName: strips Indonesian honorifics', () => {
  assert.equal(firstName('Pak Ahmad Wijaya'), 'Ahmad');
  assert.equal(firstName('Ibu Aisyah Putri'), 'Aisyah');
  assert.equal(firstName('H. Sulaiman'), 'Sulaiman');
  assert.equal(firstName('KH. Mahmud'), 'Mahmud');
});

test('firstName: handles single-token names', () => {
  assert.equal(firstName('Siti'), 'Siti');
});

test('firstName: returns dash for empty/null', () => {
  assert.equal(firstName(''), '—');
  assert.equal(firstName(null), '—');
  assert.equal(firstName(undefined), '—');
});

// ── getJemaahGroupView ───────────────────────────────────────────

test('getJemaahGroupView: returns null when no groupKey', async () => {
  const r = await getJemaahGroupView({ groupKey: null, currentBookingId: 'x' });
  assert.equal(r, null);
});

test('getJemaahGroupView: returns null when only viewer is in the group', async (t) => {
  const paket = await tempPaket(t, 'jgv-solo');
  const jemaah = await tempJemaah(t, 'jgv-solo');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const key = `G-SOL${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b.id, groupKey: key });
    // Only one member exists; current booking is the viewer → no siblings → null
    const r = await getJemaahGroupView({ groupKey: key, currentBookingId: b.id });
    assert.equal(r, null);
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('getJemaahGroupView: returns siblings excluding viewer', async (t) => {
  const paket = await tempPaket(t, 'jgv-sib');
  const j1 = await tempJemaah(t, 'jgv-sib-1');
  const j2 = await tempJemaah(t, 'jgv-sib-2');
  const j3 = await tempJemaah(t, 'jgv-sib-3');
  const b1 = await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });
  const b3 = await tempBooking({ paket, jemaahProfileId: j3.jemaah.id });
  // Override the seeded jemaah names so we can assert sanitization
  await db.jemaahProfile.update({
    where: { id: j1.jemaah.id }, data: { fullName: 'Pak Ahmad Wijaya' },
  });
  await db.jemaahProfile.update({
    where: { id: j2.jemaah.id }, data: { fullName: 'Ibu Aisyah Putri' },
  });
  await db.jemaahProfile.update({
    where: { id: j3.jemaah.id }, data: { fullName: 'Hasan' },
  });
  const key = `G-SIB${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b1.id, groupKey: key });
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b2.id, groupKey: key });
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b3.id, groupKey: key });
    // Viewer is b1
    const r = await getJemaahGroupView({ groupKey: key, currentBookingId: b1.id });
    assert.ok(r);
    assert.equal(r.siblingCount, 2);
    assert.equal(r.totalActiveMembers, 3);
    const names = r.siblings.map((s) => s.firstName).sort();
    assert.deepEqual(names, ['Aisyah', 'Hasan']);
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('getJemaahGroupView: CANCELLED siblings are not visible', async (t) => {
  const paket = await tempPaket(t, 'jgv-cxl');
  const j1 = await tempJemaah(t, 'jgv-cxl-1');
  const j2 = await tempJemaah(t, 'jgv-cxl-2');
  const j3 = await tempJemaah(t, 'jgv-cxl-3');
  const b1 = await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });
  const b3 = await tempBooking({ paket, jemaahProfileId: j3.jemaah.id });
  const key = `G-CXL${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b1.id, groupKey: key });
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b2.id, groupKey: key });
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b3.id, groupKey: key });
    // Cancel b2 directly
    await db.booking.update({ where: { id: b2.id }, data: { status: 'CANCELLED' } });
    const r = await getJemaahGroupView({ groupKey: key, currentBookingId: b1.id });
    assert.ok(r);
    assert.equal(r.siblingCount, 1, 'cancelled sibling not visible');
    assert.equal(r.totalActiveMembers, 2, 'cancelled member excluded from count');
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('getJemaahGroupView: returns label from BookingGroup when set', async (t) => {
  const paket = await tempPaket(t, 'jgv-lbl');
  const j1 = await tempJemaah(t, 'jgv-lbl-1');
  const j2 = await tempJemaah(t, 'jgv-lbl-2');
  const b1 = await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });
  const key = `G-LBL${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b1.id, groupKey: key });
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b2.id, groupKey: key });
    await setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: key, label: 'Keluarga Pak Ahmad',
    });
    const r = await getJemaahGroupView({ groupKey: key, currentBookingId: b1.id });
    assert.equal(r.label, 'Keluarga Pak Ahmad');
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('getJemaahGroupView: sibling rows carry NO money/contact/id (privacy)', async (t) => {
  const paket = await tempPaket(t, 'jgv-pri');
  const j1 = await tempJemaah(t, 'jgv-pri-1');
  const j2 = await tempJemaah(t, 'jgv-pri-2');
  const b1 = await tempBooking({ paket, jemaahProfileId: j1.jemaah.id, totalAmount: '20000000' });
  const b2 = await tempBooking({ paket, jemaahProfileId: j2.jemaah.id, totalAmount: '15000000' });
  const key = `G-PRI${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b1.id, groupKey: key });
    await setBookingGroupKey({ req: fakeReq, actor: adminActor, bookingId: b2.id, groupKey: key });
    const r = await getJemaahGroupView({ groupKey: key, currentBookingId: b1.id });
    assert.equal(r.siblings.length, 1);
    const sib = r.siblings[0];
    // What MAY be present: firstName, paxCount, kelas
    assert.ok('firstName' in sib);
    assert.ok('paxCount' in sib);
    assert.ok('kelas' in sib);
    // What MUST NOT be present: id, fullName, totalAmount, paidAmount, phone, email
    assert.equal(sib.id, undefined);
    assert.equal(sib.fullName, undefined);
    assert.equal(sib.totalAmount, undefined);
    assert.equal(sib.paidAmount, undefined);
    assert.equal(sib.phone, undefined);
    assert.equal(sib.email, undefined);
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});
