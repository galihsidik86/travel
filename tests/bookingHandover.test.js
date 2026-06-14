// Stage 280 — booking handover.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempJemaah, tempBooking } from './_helpers.js';
import {
  handoverBookingJemaah,
  resolveHandoverAuthz,
  getBookingHandoverLineage,
} from '../src/services/bookingHandover.js';

const ownerActor = { id: null, email: 'owner@test', role: 'OWNER' };
const ownerReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };
const mgrActor = { id: null, email: 'mgr@test', role: 'MANAJER_OPS' };
const kasirActor = { id: null, email: 'kasir@test', role: 'KASIR' };

test('resolveHandoverAuthz: returns role set per status', () => {
  assert.ok(resolveHandoverAuthz('PENDING').allowed.has('OWNER'));
  assert.ok(resolveHandoverAuthz('PENDING').allowed.has('SUPERADMIN'));
  assert.ok(resolveHandoverAuthz('PENDING').allowed.has('MANAJER_OPS'));
  assert.equal(resolveHandoverAuthz('PENDING').needsAck, false);

  assert.ok(resolveHandoverAuthz('PARTIAL').allowed.has('OWNER'));
  assert.ok(resolveHandoverAuthz('PARTIAL').allowed.has('SUPERADMIN'));
  assert.ok(!resolveHandoverAuthz('PARTIAL').allowed.has('MANAJER_OPS'));

  assert.equal(resolveHandoverAuthz('LUNAS').needsAck, true);
  assert.ok(resolveHandoverAuthz('LUNAS').allowed.has('OWNER'));
  assert.ok(!resolveHandoverAuthz('LUNAS').allowed.has('SUPERADMIN'));
});

test('handoverBookingJemaah: 400 on missing bookingId', async () => {
  await assert.rejects(
    () => handoverBookingJemaah({
      req: ownerReq, actor: ownerActor,
      bookingId: '', newJemaah: { fullName: 'X', phone: '+62811' },
      reason: 'test',
    }),
    (err) => err.code === 'BOOKING_ID_REQUIRED' && err.status === 400,
  );
});

test('handoverBookingJemaah: 400 on missing newJemaah name', async () => {
  await assert.rejects(
    () => handoverBookingJemaah({
      req: ownerReq, actor: ownerActor,
      bookingId: 'x', newJemaah: { phone: '+62811' }, reason: 'test',
    }),
    (err) => err.code === 'JEMAAH_NAME_REQUIRED' && err.status === 400,
  );
});

test('handoverBookingJemaah: 400 on missing newJemaah phone', async () => {
  await assert.rejects(
    () => handoverBookingJemaah({
      req: ownerReq, actor: ownerActor,
      bookingId: 'x', newJemaah: { fullName: 'New Jemaah' }, reason: 'test',
    }),
    (err) => err.code === 'JEMAAH_PHONE_REQUIRED' && err.status === 400,
  );
});

test('handoverBookingJemaah: 400 on short reason', async () => {
  await assert.rejects(
    () => handoverBookingJemaah({
      req: ownerReq, actor: ownerActor,
      bookingId: 'x', newJemaah: { fullName: 'New', phone: '+62811' },
      reason: 'x',
    }),
    (err) => err.code === 'HANDOVER_REASON_REQUIRED' && err.status === 400,
  );
});

test('handoverBookingJemaah: 404 on unknown booking', async () => {
  await assert.rejects(
    () => handoverBookingJemaah({
      req: ownerReq, actor: ownerActor,
      bookingId: 'cknotexist',
      newJemaah: { fullName: 'New', phone: '+62811' }, reason: 'family transfer',
    }),
    (err) => err.code === 'BOOKING_NOT_FOUND' && err.status === 404,
  );
});

test('handoverBookingJemaah: 409 on CANCELLED', async (t) => {
  const paket = await tempPaket(t, 'hbj-cxl');
  const jemaah = await tempJemaah(t, 'hbj-cxl');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
  await assert.rejects(
    () => handoverBookingJemaah({
      req: ownerReq, actor: ownerActor,
      bookingId: b.id,
      newJemaah: { fullName: 'New', phone: '+62811' }, reason: 'try',
    }),
    (err) => err.code === 'BOOKING_CLOSED' && err.status === 409,
  );
});

test('handoverBookingJemaah: 403 when KASIR tries handover', async (t) => {
  const paket = await tempPaket(t, 'hbj-kasir');
  const jemaah = await tempJemaah(t, 'hbj-kasir');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await assert.rejects(
    () => handoverBookingJemaah({
      req: ownerReq, actor: kasirActor,
      bookingId: b.id,
      newJemaah: { fullName: 'New', phone: '+62811' }, reason: 'kasir attempt',
    }),
    (err) => err.code === 'HANDOVER_ROLE_FORBIDDEN' && err.status === 403,
  );
});

test('handoverBookingJemaah: 403 when MANAJER_OPS tries on PARTIAL', async (t) => {
  const paket = await tempPaket(t, 'hbj-mgrpartial');
  const jemaah = await tempJemaah(t, 'hbj-mgrpartial');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'PARTIAL' } });
  await assert.rejects(
    () => handoverBookingJemaah({
      req: ownerReq, actor: mgrActor,
      bookingId: b.id,
      newJemaah: { fullName: 'New', phone: '+62811' }, reason: 'mgr attempt',
    }),
    (err) => err.code === 'HANDOVER_ROLE_FORBIDDEN' && err.status === 403,
  );
});

test('handoverBookingJemaah: 409 on LUNAS without ack', async (t) => {
  const paket = await tempPaket(t, 'hbj-lunas');
  const jemaah = await tempJemaah(t, 'hbj-lunas');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'LUNAS', paidAmount: '1000000' } });
  await assert.rejects(
    () => handoverBookingJemaah({
      req: ownerReq, actor: ownerActor,
      bookingId: b.id,
      newJemaah: { fullName: 'New', phone: '+62811' }, reason: 'lunas no-ack',
      acknowledgeLunas: false,
    }),
    (err) => err.code === 'HANDOVER_LUNAS_NEEDS_ACK' && err.status === 409,
  );
});

test('handoverBookingJemaah: LUNAS with ack proceeds', async (t) => {
  const paket = await tempPaket(t, 'hbj-lunaack');
  const jemaah = await tempJemaah(t, 'hbj-lunaack');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await db.booking.update({ where: { id: b.id }, data: { status: 'LUNAS', paidAmount: '1000000' } });
  const r = await handoverBookingJemaah({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id,
    newJemaah: { fullName: 'New Owner', phone: '+62812' },
    reason: 'lunas with ack',
    acknowledgeLunas: true,
  });
  assert.ok(r.newJemaah);
  assert.equal(r.newJemaah.fullName, 'New Owner');
  // Cleanup the spawned profile so the test fixture's deletion is clean
  t.after(() => db.jemaahProfile.deleteMany({ where: { id: r.newJemaah.id } }));
});

test('handoverBookingJemaah: same-jemaah identity refused (no-op detection)', async (t) => {
  const paket = await tempPaket(t, 'hbj-noop');
  const jemaah = await tempJemaah(t, 'hbj-noop');
  await db.jemaahProfile.update({
    where: { id: jemaah.jemaah.id },
    data: { fullName: 'Pak Ahmad', phone: '+62811-2222' },
  });
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  await assert.rejects(
    () => handoverBookingJemaah({
      req: ownerReq, actor: ownerActor,
      bookingId: b.id,
      // Same name + phone (different format but same digits)
      newJemaah: { fullName: 'Pak Ahmad', phone: '+62 811 2222' },
      reason: 'oops',
    }),
    (err) => err.code === 'HANDOVER_NO_OP' && err.status === 409,
  );
});

test('handoverBookingJemaah: re-points jemaah + spawns new profile + clears jemaahUserId', async (t) => {
  const paket = await tempPaket(t, 'hbj-ok');
  const jemaah = await tempJemaah(t, 'hbj-ok');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  // Stamp a fake jemaahUserId so we can prove handover clears it
  await db.booking.update({ where: { id: b.id }, data: { jemaahUserId: jemaah.id } });
  const r = await handoverBookingJemaah({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id,
    newJemaah: { fullName: 'Recipient Doe', phone: '+62888-7777' },
    reason: 'jemaah cant go',
  });
  assert.ok(r.newJemaah);
  assert.equal(r.newJemaah.fullName, 'Recipient Doe');
  assert.equal(r.previousJemaah.id, jemaah.jemaah.id);

  const after = await db.booking.findUnique({
    where: { id: b.id },
    select: { jemaahId: true, jemaahUserId: true },
  });
  assert.equal(after.jemaahId, r.newJemaah.id);
  assert.equal(after.jemaahUserId, null, 'jemaahUserId cleared on handover');

  // Audit row carries handover lineage
  const audit = await db.auditLog.findFirst({
    where: { entity: 'Booking', entityId: b.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit);
  assert.equal(audit.after.handover, true);
  assert.equal(audit.after.reason, 'jemaah cant go');
  assert.equal(audit.after.previousJemaahId, jemaah.jemaah.id);
  assert.equal(audit.after.newJemaahId, r.newJemaah.id);

  // Cleanup
  t.after(() => db.jemaahProfile.deleteMany({ where: { id: r.newJemaah.id } }));
});

// ── Stage 282 — getBookingHandoverLineage ────────────────────────

test('getBookingHandoverLineage: empty when no handover happened', async (t) => {
  const paket = await tempPaket(t, 'hbjl-empty');
  const jemaah = await tempJemaah(t, 'hbjl-empty');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const r = await getBookingHandoverLineage(b.id);
  assert.equal(r.length, 0);
});

test('getBookingHandoverLineage: returns null/empty on missing bookingId', async () => {
  assert.deepEqual(await getBookingHandoverLineage(null), []);
  assert.deepEqual(await getBookingHandoverLineage(''), []);
});

test('getBookingHandoverLineage: returns row carrying previous + new jemaah after handover', async (t) => {
  const paket = await tempPaket(t, 'hbjl-one');
  const jemaah = await tempJemaah(t, 'hbjl-one');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  const r1 = await handoverBookingJemaah({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id,
    newJemaah: { fullName: 'Replacement Doe', phone: '+62811-3333' },
    reason: 'first handover',
  });
  t.after(() => db.jemaahProfile.deleteMany({ where: { id: r1.newJemaah.id } }));

  const lineage = await getBookingHandoverLineage(b.id);
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0].previousJemaahId, jemaah.jemaah.id);
  assert.equal(lineage[0].newJemaahId, r1.newJemaah.id);
  assert.equal(lineage[0].reason, 'first handover');
  assert.equal(lineage[0].actorEmail, 'owner@test');
});

test('getBookingHandoverLineage: multiple handovers ordered newest first', async (t) => {
  const paket = await tempPaket(t, 'hbjl-multi');
  const jemaah = await tempJemaah(t, 'hbjl-multi');
  const b = await tempBooking({ paket, jemaahProfileId: jemaah.jemaah.id });
  // First handover
  const r1 = await handoverBookingJemaah({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id,
    newJemaah: { fullName: 'First Replacement', phone: '+62811-4444' },
    reason: 'first',
  });
  // Second handover off the first replacement
  const r2 = await handoverBookingJemaah({
    req: ownerReq, actor: ownerActor,
    bookingId: b.id,
    newJemaah: { fullName: 'Second Replacement', phone: '+62811-5555' },
    reason: 'second',
  });
  t.after(() => db.jemaahProfile.deleteMany({ where: { id: { in: [r1.newJemaah.id, r2.newJemaah.id] } } }));

  const lineage = await getBookingHandoverLineage(b.id);
  assert.equal(lineage.length, 2);
  // Newest first
  assert.equal(lineage[0].reason, 'second');
  assert.equal(lineage[1].reason, 'first');
});
