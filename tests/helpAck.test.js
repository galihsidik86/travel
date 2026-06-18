// Stage 325 — admin ACK of jemaah help request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempUser, fakeReq } from './_helpers.js';
import {
  submitJemaahHelpRequest, ackJemaahHelpRequest, getBookingHelpRequestState,
} from '../src/services/jemaahHelpRequest.js';

async function paketWindowAroundToday(t, tag) {
  const dep = new Date(); dep.setHours(0, 0, 0, 0);
  dep.setDate(dep.getDate() - 3);
  const ret = new Date(dep.getTime() + 9 * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays: 10, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
      prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    },
  });
  t.after(async () => {
    const bookings = await db.booking.findMany({ where: { paketId: paket.id }, select: { id: true } });
    if (bookings.length > 0) {
      await db.notification.deleteMany({
        where: { relatedEntity: 'Booking', relatedEntityId: { in: bookings.map((b) => b.id) } },
      });
    }
    await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
    await db.booking.deleteMany({ where: { paketId: paket.id } });
    await db.paketHarga.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

test('S325 — getBookingHelpRequestState returns pending=false when no requests', async (t) => {
  const tag = makeTag('s325a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const paket = await paketWindowAroundToday(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const state = await getBookingHelpRequestState({ bookingId: b.id });
  assert.equal(state.pending, false);
});

test('S325 — pending=true after submit, then false after ack', async (t) => {
  const tag = makeTag('s325b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const paket = await paketWindowAroundToday(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const jActor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  const aActor = { id: admin.id, email: admin.email, role: 'OWNER' };

  await submitJemaahHelpRequest({ req: fakeReq, actor: jActor, userId: jem.id, message: 'Saya butuh bantuan' });
  let state = await getBookingHelpRequestState({ bookingId: b.id });
  assert.equal(state.pending, true);
  assert.match(state.lastRequestPreview || '', /butuh bantuan/);

  await ackJemaahHelpRequest({ req: fakeReq, actor: aActor, bookingId: b.id, message: 'Saya sudah dalam perjalanan' });
  state = await getBookingHelpRequestState({ bookingId: b.id });
  assert.equal(state.pending, false);
  assert.ok(state.ackedAt);
  assert.equal(state.ackedByEmail, admin.email);
});

test('S325 — ack fires confirmation notif to jemaah inbox', async (t) => {
  const tag = makeTag('s325c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const paket = await paketWindowAroundToday(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const jActor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  const aActor = { id: admin.id, email: admin.email, role: 'OWNER' };
  await submitJemaahHelpRequest({ req: fakeReq, actor: jActor, userId: jem.id, message: 'minta tolong' });
  await ackJemaahHelpRequest({ req: fakeReq, actor: aActor, bookingId: b.id });

  const notif = await db.notification.findFirst({
    where: { type: 'JEMAAH_HELP_ACK', relatedEntityId: b.id, recipientUserId: jem.id },
    orderBy: { createdAt: 'desc' },
    select: { subject: true, body: true },
  });
  assert.ok(notif, 'jemaah inbox notif fired');
  assert.match(notif.subject, /Tim sudah respon/);
});

test('S325 — refuses ack when no pending request', async (t) => {
  const tag = makeTag('s325d');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const paket = await paketWindowAroundToday(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const aActor = { id: admin.id, email: admin.email, role: 'OWNER' };
  await assert.rejects(
    ackJemaahHelpRequest({ req: fakeReq, actor: aActor, bookingId: b.id }),
    /Tidak ada permintaan bantuan/,
  );
});
