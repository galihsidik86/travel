// Stage 259 — manual group assignment.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  setBookingGroupKey,
  normaliseGroupKey,
  generateGroupKey,
  getBookingGroup,
  setGroupLabel,
} from '../src/services/bookingGroup.js';

const adminActor = { id: null, email: 'admin@test', role: 'OWNER' };
const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

test('generateGroupKey: returns G- prefixed 6-char hex', () => {
  const a = generateGroupKey();
  const b = generateGroupKey();
  assert.match(a, /^G-[A-F0-9]{6}$/);
  assert.notEqual(a, b);
});

test('normaliseGroupKey: trims + uppercases valid input', () => {
  assert.equal(normaliseGroupKey('  g-ab12cd  '), 'G-AB12CD');
  assert.equal(normaliseGroupKey('G-XYZ123'), 'G-XYZ123');
});

test('normaliseGroupKey: rejects malformed input (returns null)', () => {
  assert.equal(normaliseGroupKey(''), null);
  assert.equal(normaliseGroupKey(null), null);
  assert.equal(normaliseGroupKey(undefined), null);
  assert.equal(normaliseGroupKey('hello'), null);
  assert.equal(normaliseGroupKey('G-'), null); // too short
  assert.equal(normaliseGroupKey('G-XYZ!'), null); // bad char
  assert.equal(normaliseGroupKey('NEW'), null); // bare NEW not a valid stored key
});

test('normaliseGroupKey: accepts variable suffix length (4-12 chars)', () => {
  assert.equal(normaliseGroupKey('G-AB12'), 'G-AB12');
  assert.equal(normaliseGroupKey('G-ABCD1234EFGH'), 'G-ABCD1234EFGH');
  assert.equal(normaliseGroupKey('G-ABCD1234EFGHX'), null); // 13 chars after prefix → too long
});

test('setBookingGroupKey: 404 on unknown booking', async () => {
  await assert.rejects(
    () => setBookingGroupKey({
      req: fakeReq, actor: adminActor,
      bookingId: 'cknotexist',
      groupKey: 'G-AB12CD',
    }),
    (err) => err.code === 'BOOKING_NOT_FOUND' && err.status === 404,
  );
});

test('setBookingGroupKey: 400 on malformed groupKey', async (t) => {
  const paket = await tempPaket(t, 'grp-mal');
  const jemaah = await tempJemaah(t, 'grp-mal');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await assert.rejects(
    () => setBookingGroupKey({
      req: fakeReq, actor: adminActor,
      bookingId: b.id,
      groupKey: 'not-a-valid-key',
    }),
    (err) => err.code === 'BAD_GROUP_KEY' && err.status === 400,
  );
});

test('setBookingGroupKey: refuses on CANCELLED', async (t) => {
  const paket = await tempPaket(t, 'grp-cxl');
  const jemaah = await tempJemaah(t, 'grp-cxl');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
  await assert.rejects(
    () => setBookingGroupKey({
      req: fakeReq, actor: adminActor,
      bookingId: b.id, groupKey: 'G-AB12CD',
    }),
    (err) => err.code === 'BOOKING_CLOSED' && err.status === 409,
  );
});

test('setBookingGroupKey: assigns G-XXXX value to a fresh booking', async (t) => {
  const paket = await tempPaket(t, 'grp-set');
  const jemaah = await tempJemaah(t, 'grp-set');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const result = await setBookingGroupKey({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, groupKey: 'G-FAMILY1',
  });
  assert.equal(result.updated, true);
  assert.equal(result.groupKey, 'G-FAMILY1');
  const after = await db.booking.findUnique({ where: { id: b.id }, select: { groupKey: true } });
  assert.equal(after.groupKey, 'G-FAMILY1');
});

test('setBookingGroupKey: NEW sentinel mints fresh G-XXXXXX', async (t) => {
  const paket = await tempPaket(t, 'grp-new');
  const jemaah = await tempJemaah(t, 'grp-new');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const result = await setBookingGroupKey({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, groupKey: 'NEW',
  });
  assert.equal(result.updated, true);
  assert.equal(result.groupCreated, true);
  assert.match(result.groupKey, /^G-[A-F0-9]{6}$/);
});

test('setBookingGroupKey: null/empty clears existing group', async (t) => {
  const paket = await tempPaket(t, 'grp-clr');
  const jemaah = await tempJemaah(t, 'grp-clr');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await setBookingGroupKey({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, groupKey: 'G-AB12CD',
  });
  const cleared = await setBookingGroupKey({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, groupKey: null,
  });
  assert.equal(cleared.updated, true);
  assert.equal(cleared.groupKey, null);
  const after = await db.booking.findUnique({ where: { id: b.id }, select: { groupKey: true } });
  assert.equal(after.groupKey, null);
});

test('setBookingGroupKey: same value → no-op (no audit pollution)', async (t) => {
  const paket = await tempPaket(t, 'grp-noop');
  const jemaah = await tempJemaah(t, 'grp-noop');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await setBookingGroupKey({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, groupKey: 'G-AB12CD',
  });
  const auditCountBefore = await db.auditLog.count({
    where: { entity: 'Booking', entityId: b.id, action: 'UPDATE' },
  });
  const r2 = await setBookingGroupKey({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, groupKey: 'G-AB12CD',
  });
  assert.equal(r2.updated, false);
  const auditCountAfter = await db.auditLog.count({
    where: { entity: 'Booking', entityId: b.id, action: 'UPDATE' },
  });
  assert.equal(auditCountBefore, auditCountAfter);
});

test('setBookingGroupKey: links two bookings into same group', async (t) => {
  const paket = await tempPaket(t, 'grp-link');
  const j1 = await tempJemaah(t, 'grp-link-1');
  const j2 = await tempJemaah(t, 'grp-link-2');
  const b1 = await tempBooking({ paket, jemaahProfileId: j1.jemaah.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: j2.jemaah.id });
  // First booking gets a fresh group via NEW
  const r1 = await setBookingGroupKey({
    req: fakeReq, actor: adminActor,
    bookingId: b1.id, groupKey: 'NEW',
  });
  const key = r1.groupKey;
  // Second booking joins the same group by exact key
  const r2 = await setBookingGroupKey({
    req: fakeReq, actor: adminActor,
    bookingId: b2.id, groupKey: key,
  });
  assert.equal(r2.updated, true);
  assert.equal(r2.groupKey, key);
  // Verify both share the same key
  const after1 = await db.booking.findUnique({ where: { id: b1.id }, select: { groupKey: true } });
  const after2 = await db.booking.findUnique({ where: { id: b2.id }, select: { groupKey: true } });
  assert.equal(after1.groupKey, after2.groupKey);
});

test('setBookingGroupKey: lowercase input normalised to uppercase', async (t) => {
  const paket = await tempPaket(t, 'grp-lo');
  const jemaah = await tempJemaah(t, 'grp-lo');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const r = await setBookingGroupKey({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, groupKey: 'g-ab12cd',
  });
  assert.equal(r.groupKey, 'G-AB12CD');
});

test('setBookingGroupKey: writes audit row carrying before+after groupKey', async (t) => {
  const paket = await tempPaket(t, 'grp-aud');
  const jemaah = await tempJemaah(t, 'grp-aud');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await setBookingGroupKey({
    req: fakeReq, actor: adminActor,
    bookingId: b.id, groupKey: 'G-AUDIT1',
  });
  const a = await db.auditLog.findFirst({
    where: { entity: 'Booking', entityId: b.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(a);
  assert.equal(a.before.groupKey, null);
  assert.equal(a.after.groupKey, 'G-AUDIT1');
  assert.equal(a.after.groupKeyManuallySet, true);
});

// ── Stage 260 — BookingGroup label + getBookingGroup ─────────────

test('getBookingGroup: null on unknown key (no members, no meta row)', async () => {
  const r = await getBookingGroup('G-NOPE99');
  assert.equal(r, null);
});

test('getBookingGroup: returns synthesized row when members exist but no meta', async (t) => {
  const paket = await tempPaket(t, 'grp-syn');
  const jemaah = await tempJemaah(t, 'grp-syn');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const key = `G-SYN${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  // Directly stamp groupKey without going through setBookingGroupKey, to
  // skip the BookingGroup pre-create (simulating a S257 clone-born group
  // that pre-dates the BookingGroup table existing).
  await db.booking.update({ where: { id: b.id }, data: { groupKey: key } });
  await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  const r = await getBookingGroup(key);
  assert.ok(r);
  assert.equal(r.label, null);
  assert.equal(r.members.length, 1);
  assert.equal(r.members[0].bookingNo, b.bookingNo);
});

test('setGroupLabel: 400 on malformed key', async () => {
  await assert.rejects(
    () => setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: 'not-valid', label: 'X',
    }),
    (err) => err.code === 'BAD_GROUP_KEY' && err.status === 400,
  );
});

test('setGroupLabel: creates BookingGroup row on first call', async () => {
  const key = `G-LBL${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    const r = await setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: key, label: 'Keluarga Pak Ahmad',
    });
    assert.equal(r.updated, true);
    assert.equal(r.group.label, 'Keluarga Pak Ahmad');
    const fetched = await db.bookingGroup.findUnique({ where: { groupKey: key } });
    assert.equal(fetched.label, 'Keluarga Pak Ahmad');
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('setGroupLabel: trims + caps label at 120 chars', async () => {
  const key = `G-CAP${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    const long = '  ' + 'x'.repeat(200) + '  ';
    const r = await setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: key, label: long,
    });
    assert.equal(r.group.label.length, 120);
    assert.ok(!r.group.label.startsWith(' '));
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('setGroupLabel: explicit empty string clears the label', async () => {
  const key = `G-CLR${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: key, label: 'temp',
    });
    const r = await setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: key, label: '',
    });
    assert.equal(r.updated, true);
    assert.equal(r.group.label, null);
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('setGroupLabel: omitting label leaves it unchanged (notes-only update)', async () => {
  const key = `G-OMI${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: key, label: 'Keep me', notes: 'first',
    });
    const r = await setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: key, notes: 'updated',
      // label intentionally omitted
    });
    assert.equal(r.updated, true);
    assert.equal(r.group.label, 'Keep me');
    assert.equal(r.group.notes, 'updated');
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('setGroupLabel: same value → no-op (no audit pollution)', async () => {
  const key = `G-NOP${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: key, label: 'same',
    });
    const before = await db.auditLog.count({
      where: { entity: 'BookingGroup', entityId: key },
    });
    const r2 = await setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: key, label: 'same',
    });
    assert.equal(r2.updated, false);
    const after = await db.auditLog.count({
      where: { entity: 'BookingGroup', entityId: key },
    });
    assert.equal(before, after);
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});

test('getBookingGroup: returns label after setGroupLabel + members linked', async (t) => {
  const paket = await tempPaket(t, 'grp-full');
  const jemaah = await tempJemaah(t, 'grp-full');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const key = `G-FUL${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  try {
    await setBookingGroupKey({
      req: fakeReq, actor: adminActor,
      bookingId: b.id, groupKey: key,
    });
    await setGroupLabel({
      req: fakeReq, actor: adminActor,
      groupKey: key, label: 'Keluarga Test', notes: 'Catatan internal',
    });
    const r = await getBookingGroup(key);
    assert.equal(r.label, 'Keluarga Test');
    assert.equal(r.notes, 'Catatan internal');
    assert.equal(r.members.length, 1);
    assert.equal(r.members[0].bookingNo, b.bookingNo);
  } finally {
    await db.bookingGroup.deleteMany({ where: { groupKey: key } });
  }
});
