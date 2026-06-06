// Stage 26 — paket waitlist service.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempUser, fakeReq } from './_helpers.js';
import {
  joinWaitlist, listWaitlist, promoteWaitlist, cancelWaitlist, isFullPaket,
} from '../src/services/waitlist.js';

function fillPaket(paketId) {
  return db.paket.update({
    where: { id: paketId },
    data: { kursiTerisi: { set: 999 }, kursiTotal: 999 }, // force "full"
  });
}

describe('joinWaitlist — public sign-up', () => {
  test('refuses when kursi not yet full', async (t) => {
    const tag = makeTag('wl-not-full');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await assert.rejects(
      () => joinWaitlist({ req: fakeReq, paketSlug: paket.slug, input: { fullName: 'Alpha One', phone: '08123456789' } }),
      (err) => err.status === 409 && err.code === 'PAKET_NOT_FULL',
    );
  });

  test('upsert on (paketId, phone) — re-submit doesn\'t dupe', async (t) => {
    const tag = makeTag('wl-upsert');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await fillPaket(paket.id);

    const first = await joinWaitlist({
      req: fakeReq, paketSlug: paket.slug,
      input: { fullName: 'Pak Hasan', phone: `0822-${tag.slice(-4)}` },
    });
    const second = await joinWaitlist({
      req: fakeReq, paketSlug: paket.slug,
      input: { fullName: 'Pak Hasan Wibowo', phone: `0822-${tag.slice(-4)}` },
    });
    assert.equal(first.waitlist.id, second.waitlist.id, 'same row');
    assert.equal(second.waitlist.fullName, 'Pak Hasan Wibowo', 'fullName refreshed');

    const all = await db.paketWaitlist.findMany({
      where: { paketId: paket.id, phone: `0822-${tag.slice(-4)}` },
    });
    assert.equal(all.length, 1, 'no duplicate row');
    t.after(async () => { await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } }); });
  });

  test('re-joining after CANCELLED reopens to WAITING', async (t) => {
    const tag = makeTag('wl-reopen');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await fillPaket(paket.id);
    const admin = await tempUser(t, tag, { role: 'OWNER' });

    const r = await joinWaitlist({
      req: fakeReq, paketSlug: paket.slug,
      input: { fullName: 'Bu Aminah', phone: '0833-RJOIN' },
    });
    await cancelWaitlist({ req: fakeReq, actor: admin, id: r.waitlist.id });
    const reopen = await joinWaitlist({
      req: fakeReq, paketSlug: paket.slug,
      input: { fullName: 'Bu Aminah', phone: '0833-RJOIN' },
    });
    assert.equal(reopen.waitlist.id, r.waitlist.id);
    assert.equal(reopen.waitlist.status, 'WAITING');
    assert.equal(reopen.waitlist.cancelledAt, null);
    t.after(async () => { await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } }); });
  });

  test('rejects on too-short name/phone', async (t) => {
    const tag = makeTag('wl-bad');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await fillPaket(paket.id);
    await assert.rejects(
      () => joinWaitlist({ req: fakeReq, paketSlug: paket.slug, input: { fullName: 'A', phone: '08' } }),
      (err) => err.status === 400,
    );
  });

  test('isFullPaket helper', () => {
    assert.equal(isFullPaket({ kursiTerisi: 5, kursiTotal: 10 }), false);
    assert.equal(isFullPaket({ kursiTerisi: 10, kursiTotal: 10 }), true);
    assert.equal(isFullPaket({ kursiTerisi: 11, kursiTotal: 10 }), true);
  });
});

describe('listWaitlist + counts', () => {
  test('split rows by status, oldest first', async (t) => {
    const tag = makeTag('wl-list');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await fillPaket(paket.id);
    const admin = await tempUser(t, tag, { role: 'OWNER' });

    const a = await joinWaitlist({ req: fakeReq, paketSlug: paket.slug, input: { fullName: 'Alpha One', phone: 'X-A-PHONE' } });
    const b = await joinWaitlist({ req: fakeReq, paketSlug: paket.slug, input: { fullName: 'Beta Two', phone: 'X-B-PHONE' } });
    await cancelWaitlist({ req: fakeReq, actor: admin, id: b.waitlist.id });

    const r = await listWaitlist(paket.slug);
    assert.equal(r.rows.length, 2);
    assert.equal(r.counts.waiting, 1);
    assert.equal(r.counts.cancelled, 1);
    assert.equal(r.counts.promoted, 0);
    assert.equal(r.rows[0].id, a.waitlist.id, 'oldest first');
    t.after(async () => { await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } }); });
  });
});

describe('promoteWaitlist — creates booking + flips status', () => {
  test('WAITING → PROMOTED + backref to booking', async (t) => {
    const tag = makeTag('wl-promote');
    const paket = await tempPaket(t, `pkt-${tag}`);
    // Save real kursiTotal so we can un-fill it
    const original = await db.paket.findUnique({ where: { id: paket.id } });
    await fillPaket(paket.id);
    const admin = await tempUser(t, tag, { role: 'OWNER' });

    const wl = await joinWaitlist({
      req: fakeReq, paketSlug: paket.slug,
      input: { fullName: 'Promo Test', phone: '0844-PROMO' },
    });

    // Un-fill so createBooking inside promoteWaitlist doesn't trip the kursi check
    await db.paket.update({
      where: { id: paket.id },
      data: { kursiTerisi: 0, kursiTotal: original.kursiTotal },
    });

    const result = await promoteWaitlist({
      req: fakeReq, actor: admin, id: wl.waitlist.id,
      kelas: 'QUAD', paxCount: 1,
    });
    assert.ok(result.booking.id);
    assert.equal(result.waitlist.status, 'PROMOTED');
    assert.equal(result.waitlist.promotedBookingId, result.booking.id);

    t.after(async () => {
      await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } });
      await db.payment.deleteMany({ where: { bookingId: result.booking.id } });
      await db.komisi.deleteMany({ where: { bookingId: result.booking.id } });
      await db.booking.deleteMany({ where: { id: result.booking.id } });
    });
  });

  test('refuses promote on already-PROMOTED row (409)', async (t) => {
    const tag = makeTag('wl-double');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await fillPaket(paket.id);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const wl = await joinWaitlist({ req: fakeReq, paketSlug: paket.slug, input: { fullName: 'Double Promote', phone: '0855-DBL-9001' } });
    await db.paket.update({ where: { id: paket.id }, data: { kursiTerisi: 0, kursiTotal: 10 } });
    const first = await promoteWaitlist({
      req: fakeReq, actor: admin, id: wl.waitlist.id, kelas: 'QUAD', paxCount: 1,
    });
    await assert.rejects(
      () => promoteWaitlist({
        req: fakeReq, actor: admin, id: wl.waitlist.id, kelas: 'QUAD', paxCount: 1,
      }),
      (err) => err.status === 409 && err.code === 'NOT_WAITING',
    );
    t.after(async () => {
      await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } });
      await db.payment.deleteMany({ where: { bookingId: first.booking.id } });
      await db.komisi.deleteMany({ where: { bookingId: first.booking.id } });
      await db.booking.deleteMany({ where: { id: first.booking.id } });
    });
  });
});

describe('cancelWaitlist', () => {
  test('refuses on PROMOTED row', async (t) => {
    const tag = makeTag('wl-cancel-promoted');
    const paket = await tempPaket(t, `pkt-${tag}`);
    await fillPaket(paket.id);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    const wl = await joinWaitlist({ req: fakeReq, paketSlug: paket.slug, input: { fullName: 'Cancel-Test', phone: '0866-CP-9002' } });
    await db.paket.update({ where: { id: paket.id }, data: { kursiTerisi: 0, kursiTotal: 10 } });
    const r = await promoteWaitlist({ req: fakeReq, actor: admin, id: wl.waitlist.id, kelas: 'QUAD', paxCount: 1 });

    await assert.rejects(
      () => cancelWaitlist({ req: fakeReq, actor: admin, id: wl.waitlist.id }),
      (err) => err.status === 409 && err.code === 'ALREADY_PROMOTED',
    );
    t.after(async () => {
      await db.paketWaitlist.deleteMany({ where: { paketId: paket.id } });
      await db.payment.deleteMany({ where: { bookingId: r.booking.id } });
      await db.komisi.deleteMany({ where: { bookingId: r.booking.id } });
      await db.booking.deleteMany({ where: { id: r.booking.id } });
    });
  });
});
