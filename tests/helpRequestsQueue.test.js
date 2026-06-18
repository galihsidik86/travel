// Stage 331 + S332 — help requests admin queue + escalation cron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah, tempUser, fakeReq } from './_helpers.js';
import {
  submitJemaahHelpRequest, ackJemaahHelpRequest,
  listPendingHelpRequests,
} from '../src/services/jemaahHelpRequest.js';
import {
  getStaleHelpRequests, escalateStaleHelpRequests,
} from '../src/services/helpRequestEscalate.js';

async function inTripPaket(t, tag) {
  const dep = new Date(); dep.setHours(0, 0, 0, 0); dep.setDate(dep.getDate() - 3);
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

test('S331 — listPendingHelpRequests returns empty envelope when no requests', async () => {
  const r = await listPendingHelpRequests({ now: new Date('3000-01-01') });
  // The far-future `now` ensures no DB rows match the 90d window.
  assert.deepEqual(r.rows, []);
  assert.equal(r.counts.pending, 0);
});

test('S331 — pending request surfaces in queue, then disappears after ACK', async (t) => {
  const tag = makeTag('s331a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const admin = await tempUser(t, `${tag}-adm`, { role: 'OWNER' });
  const paket = await inTripPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  const jActor = { id: jem.id, email: jem.email, role: 'JEMAAH' };
  const aActor = { id: admin.id, email: admin.email, role: 'OWNER' };

  await submitJemaahHelpRequest({ req: fakeReq, actor: jActor, userId: jem.id, message: 'Saya butuh bantuan urgent' });
  let r = await listPendingHelpRequests({});
  const mine = r.rows.find((x) => x.bookingId === b.id);
  assert.ok(mine, 'pending help request surfaces in queue');
  assert.match(mine.messagePreview || '', /butuh bantuan urgent/);

  await ackJemaahHelpRequest({ req: fakeReq, actor: aActor, bookingId: b.id, message: 'tim menuju lokasi' });
  r = await listPendingHelpRequests({});
  const gone = r.rows.find((x) => x.bookingId === b.id);
  assert.equal(gone, undefined, 'acked request removed from queue');
});

test('S332 — getStaleHelpRequests picks up requests older than threshold', async (t) => {
  const tag = makeTag('s332a');
  const jem = await tempJemaah(t, `${tag}-j`);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const paket = await inTripPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  // Inject an old JEMAAH_HELP_REQUEST notif (5h ago)
  await db.notification.create({
    data: {
      type: 'JEMAAH_HELP_REQUEST', channel: 'EMAIL',
      recipientEmail: 'x@y',
      subject: 'past', body: 'past',
      status: 'SENT', sentAt: new Date(),
      payload: { messagePreview: 'old SOS' },
      createdAt: new Date(Date.now() - 5 * 3_600_000),
      relatedEntity: 'Booking', relatedEntityId: b.id,
    },
  });

  const stale = await getStaleHelpRequests({ olderThanHours: 2 });
  const found = stale.find((s) => s.bookingId === b.id);
  assert.ok(found, 'stale request surfaces');
  assert.ok(found.ageHours >= 2);
});

test('S332 — escalateStaleHelpRequests fan-outs to OWNER + stamps via notif', async (t) => {
  const tag = makeTag('s332b');
  const jem = await tempJemaah(t, `${tag}-j`);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const paket = await inTripPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  await db.notification.create({
    data: {
      type: 'JEMAAH_HELP_REQUEST', channel: 'EMAIL',
      recipientEmail: 'x@y', subject: 'past', body: 'past',
      status: 'SENT', sentAt: new Date(),
      payload: { messagePreview: 'lost in masjidil haram' },
      createdAt: new Date(Date.now() - 4 * 3_600_000),
      relatedEntity: 'Booking', relatedEntityId: b.id,
    },
  });

  const r = await escalateStaleHelpRequests({ olderThanHours: 2 });
  assert.ok(r.candidateCount >= 1);
  // Verify the escalation notif landed
  const esc = await db.notification.findFirst({
    where: { type: 'JEMAAH_HELP_ESCALATED', relatedEntityId: b.id, recipientEmail: owner.email },
    select: { subject: true, body: true },
  });
  assert.ok(esc, 'escalation notif fired to OWNER');
  assert.match(esc.subject, /SOS belum di-handle/);
  assert.match(esc.body, /lost in masjidil haram/);
});

test('S332 — re-running on already-escalated booking is a no-op', async (t) => {
  const tag = makeTag('s332c');
  const jem = await tempJemaah(t, `${tag}-j`);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  const paket = await inTripPaket(t, `${tag}-p`);
  const b = await db.booking.create({
    data: {
      bookingNo: `RP-${tag}-1`,
      paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
      kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
    },
  });
  await db.notification.create({
    data: {
      type: 'JEMAAH_HELP_REQUEST', channel: 'EMAIL',
      recipientEmail: 'x@y', subject: 'past', body: 'past',
      status: 'SENT', sentAt: new Date(),
      createdAt: new Date(Date.now() - 5 * 3_600_000),
      relatedEntity: 'Booking', relatedEntityId: b.id,
    },
  });
  // Pre-existing escalation
  await db.notification.create({
    data: {
      type: 'JEMAAH_HELP_ESCALATED', channel: 'EMAIL',
      recipientEmail: 'x@y', subject: 'past esc', body: 'past',
      status: 'SENT', sentAt: new Date(),
      createdAt: new Date(Date.now() - 2 * 3_600_000),
      relatedEntity: 'Booking', relatedEntityId: b.id,
    },
  });

  const stale = await getStaleHelpRequests({ olderThanHours: 2 });
  const found = stale.find((s) => s.bookingId === b.id);
  assert.equal(found, undefined, 'already-escalated booking excluded');
});
