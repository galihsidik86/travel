// Stage 321 — jemaah SOS-light help request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempUser, fakeReq } from './_helpers.js';
import {
  submitJemaahHelpRequest, MIN_MESSAGE_LEN,
} from '../src/services/jemaahHelpRequest.js';
import { env } from '../src/env.js';

async function paketWindowAroundToday(t, tag, { daysAgo = 3, durationDays = 10 } = {}) {
  const dep = new Date(); dep.setHours(0, 0, 0, 0);
  dep.setDate(dep.getDate() - daysAgo);
  const ret = new Date(dep.getTime() + (durationDays - 1) * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: ret,
      durationDays, inclusions: [], exclusions: [], kursiTotal: 10, status: 'ACTIVE',
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

test('S321 — rejects when message too short', async (t) => {
  const tag = makeTag('s321a');
  const jem = await tempJemaah(t, tag);
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  await assert.rejects(
    submitJemaahHelpRequest({ req: fakeReq, actor, userId: jem.id, message: 'hi' }),
    /minimal 5/,
  );
});

test('S321 — rejects when jemaah has no in-trip booking', async (t) => {
  const tag = makeTag('s321b');
  const jem = await tempJemaah(t, tag);
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  await assert.rejects(
    submitJemaahHelpRequest({ req: fakeReq, actor, userId: jem.id, message: 'butuh bantuan sekarang' }),
    /Hanya jemaah dalam perjalanan/,
  );
});

test('S321 — fan-outs EMAIL + WA to admin + crew + appends booking note', async (t) => {
  const tag = makeTag('s321c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const paket = await paketWindowAroundToday(t, `${tag}-pkt`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  const result = await submitJemaahHelpRequest({
    req: fakeReq, actor, userId: jem.id, message: 'Saya hilang dari rombongan di Masjidil Haram',
  });
  assert.ok(result.recipients >= 1);
  assert.ok(result.enqueued >= 1);
  // Notif row exists
  const notif = await db.notification.findFirst({
    where: { type: 'JEMAAH_HELP_REQUEST', relatedEntityId: b.id, recipientEmail: owner.email },
    orderBy: { createdAt: 'desc' },
    select: { subject: true, body: true },
  });
  assert.ok(notif);
  assert.match(notif.subject, /Bantuan diminta/);
  assert.match(notif.body, /Masjidil Haram/);
  // Booking note appended
  const fresh = await db.booking.findUnique({ where: { id: b.id }, select: { notes: true } });
  assert.match(fresh.notes, /SOS-LIGHT/);
  assert.match(fresh.notes, /Masjidil Haram/);
});

test('S321 — rate-limited within env.SOS_COOLDOWN_MIN window', async (t) => {
  // Skip when admin opted out of cooldown via env (SOS_COOLDOWN_MIN=0).
  if (env.SOS_COOLDOWN_MIN === 0) {
    t.skip('SOS_COOLDOWN_MIN=0 disables the rate limit');
    return;
  }
  const tag = makeTag('s321d');
  const jem = await tempJemaah(t, `${tag}-j`);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const paket = await paketWindowAroundToday(t, `${tag}-pkt`);
  await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const actor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  await submitJemaahHelpRequest({ req: fakeReq, actor, userId: jem.id, message: 'pertama kali' });
  await assert.rejects(
    submitJemaahHelpRequest({ req: fakeReq, actor, userId: jem.id, message: 'kedua kali' }),
    /Terlalu cepat/,
  );
});

test('S321 — message length constant exported', () => {
  assert.equal(MIN_MESSAGE_LEN, 5);
});

test('S321 — cooldown configurable via env (default 5min, clamp 0..120)', () => {
  assert.ok(Number.isInteger(env.SOS_COOLDOWN_MIN));
  assert.ok(env.SOS_COOLDOWN_MIN >= 0 && env.SOS_COOLDOWN_MIN <= 120);
});
