// Stage 19 — print manifest service. Verifies the data shape feeding
// print-manifest.ejs: active-only bookings, room-sort order, doc pills
// attached, count summary.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah } from './_helpers.js';
import { getPrintManifest } from '../src/services/adminDashboard.js';

async function tempBooking(t, { paket, jemaah, status = 'PENDING', kelas = 'QUAD', paxCount = 1 }) {
  const bk = await db.booking.create({
    data: {
      bookingNo: `RP-${makeTag('bk').slice(0, 20)}`,
      paketId: paket.id, jemaahId: jemaah.id,
      kelas, paxCount, totalAmount: '10000000', paidAmount: '0', status,
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: bk.id } });
  });
  return bk;
}

describe('getPrintManifest', () => {
  test('returns null for unknown slug', async () => {
    assert.equal(await getPrintManifest('does-not-exist-slug-xyz'), null);
  });

  test('CANCELLED + REFUNDED bookings excluded; everyone else included', async (t) => {
    const tag = makeTag('print-active');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJemaah(t, tag);
    await tempBooking(t, { paket, jemaah: jem.jemaah, status: 'PENDING' });
    await tempBooking(t, { paket, jemaah: jem.jemaah, status: 'LUNAS' });
    await tempBooking(t, { paket, jemaah: jem.jemaah, status: 'CANCELLED' });
    await tempBooking(t, { paket, jemaah: jem.jemaah, status: 'REFUNDED' });

    const m = await getPrintManifest(paket.slug);
    assert.ok(m);
    assert.equal(m.counts.activeCount, 2, '2 active bookings');
    assert.ok(m.bookings.every((b) => b.status !== 'CANCELLED' && b.status !== 'REFUNDED'));
  });

  test('rows sort by room first (grouped), unassigned go last by name', async (t) => {
    const tag = makeTag('print-sort');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const room = await db.room.create({
      data: { paketId: paket.id, roomNo: `M-${tag}-501`, floor: 5, wing: 'A', kelas: 'QUAD', capacity: 4 },
    });
    t.after(async () => {
      await db.room.deleteMany({ where: { id: room.id } });
    });
    const jemA = await tempJemaah(t, `${tag}-a`);
    const jemB = await tempJemaah(t, `${tag}-b`);
    // Update jemaah names so we get a predictable alphabetical order on unassigned
    await db.jemaahProfile.update({ where: { id: jemA.jemaah.id }, data: { fullName: 'Zulkifli Unassigned' } });
    await db.jemaahProfile.update({ where: { id: jemB.jemaah.id }, data: { fullName: 'Aisyah Roomie' } });

    const bkUnassigned = await tempBooking(t, { paket, jemaah: jemA.jemaah });
    const bkAssigned = await tempBooking(t, { paket, jemaah: jemB.jemaah });
    await db.booking.update({ where: { id: bkAssigned.id }, data: { roomId: room.id } });

    const m = await getPrintManifest(paket.slug);
    assert.equal(m.bookings.length, 2);
    // Assigned room comes first regardless of name; unassigned trails
    assert.equal(m.bookings[0].id, bkAssigned.id, 'assigned room sorts first');
    assert.equal(m.bookings[1].id, bkUnassigned.id, 'unassigned trails');
    assert.equal(m.counts.unassignedRoomCount, 1);
  });

  test('jemaah.docPills attached per booking', async (t) => {
    const tag = makeTag('print-pills');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJemaah(t, tag);
    await tempBooking(t, { paket, jemaah: jem.jemaah });
    await db.jemaahDocument.create({
      data: {
        jemaahId: jem.jemaah.id,
        type: 'PASSPORT', status: 'VERIFIED',
        refNumber: 'A1234567',
      },
    });
    t.after(async () => {
      await db.jemaahDocument.deleteMany({ where: { jemaahId: jem.jemaah.id } });
    });

    const m = await getPrintManifest(paket.slug);
    const b = m.bookings[0];
    assert.ok(Array.isArray(b.jemaah.docPills), 'docPills array present');
    assert.ok(b.jemaah.docPills.length > 0, 'doc pills computed');
  });

  test('paxCount aggregates correctly', async (t) => {
    const tag = makeTag('print-pax');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJemaah(t, tag);
    await tempBooking(t, { paket, jemaah: jem.jemaah, paxCount: 2 });
    await tempBooking(t, { paket, jemaah: jem.jemaah, paxCount: 3 });

    const m = await getPrintManifest(paket.slug);
    assert.equal(m.counts.activeCount, 2);
    assert.equal(m.counts.paxCount, 5, '2 + 3 PAX');
  });

  test('soft-deleted paket → null', async (t) => {
    const tag = makeTag('print-deleted');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await db.paket.update({ where: { id: paket.id }, data: { deletedAt: new Date() } });
    const m = await getPrintManifest(paket.slug);
    assert.equal(m, null);
  });
});
