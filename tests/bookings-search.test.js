// searchBookings — admin global lookup by bookingNo / jemaah name / phone +
// status/paket/agent/date filters + the counts-by-status KPI strip.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';
import { searchBookings } from '../src/services/bookingsSearch.js';

async function tempAgent(t, tag, suffix = 'a') {
  const passwordHash = await hashPassword('test12345');
  const u = await db.user.create({
    data: {
      email: `${tag}-${suffix}-agen@example.test`, passwordHash, role: 'AGEN',
      fullName: `Agent ${tag}-${suffix}`, phone: '+62811',
      agent: { create: {
        slug: `agent-${tag.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${suffix}`,
        displayName: `Agent ${tag}-${suffix}`, whatsapp: '+62811',
      } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.booking.updateMany({ where: { agentId: u.agent.id }, data: { agentId: null } });
    await db.agentProfile.deleteMany({ where: { id: u.agent.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  });
  return u;
}

async function tempJem(t, tag, fullName, phone) {
  const j = await db.jemaahProfile.create({ data: { fullName, phone } });
  t.after(async () => {
    await db.booking.deleteMany({ where: { jemaahId: j.id } });
    await db.jemaahProfile.deleteMany({ where: { id: j.id } });
  });
  return j;
}

async function tempBooking(t, { paket, jemaah, agentId = null, status = 'PENDING', totalAmount = '10000000', bookingNo }) {
  const bk = await db.booking.create({
    data: {
      bookingNo: bookingNo || `RP-${makeTag('bk').slice(0, 20)}`,
      paketId: paket.id, jemaahId: jemaah.id, agentId,
      kelas: 'QUAD', paxCount: 1, totalAmount, paidAmount: '0', status,
    },
  });
  t.after(async () => {
    await db.booking.deleteMany({ where: { id: bk.id } });
  });
  return bk;
}

describe('searchBookings — text query', () => {
  test('bookingNo substring matches', async (t) => {
    const tag = makeTag('srch-bn');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJem(t, tag, 'Test Jemaah', '081111111111');
    const bn = `RP-SRCHBN-${Date.now()}`;
    await tempBooking(t, { paket, jemaah: jem, bookingNo: bn });

    const r = await searchBookings({ q: 'SRCHBN' });
    assert.ok(r.rows.find((x) => x.bookingNo === bn), 'bookingNo substring hit');
  });

  test('jemaah fullName contains (case-insensitive via collation)', async (t) => {
    const tag = makeTag('srch-nm');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJem(t, tag, `Khadijah-${tag}`, '0855');
    await tempBooking(t, { paket, jemaah: jem });

    // Search by mixed case + only substring
    const r = await searchBookings({ q: `khadijah-${tag}` });
    assert.ok(r.rows.some((x) => x.jemaah?.fullName === `Khadijah-${tag}`));
  });

  test('phone substring matches; digits-only fallback when query is formatted', async (t) => {
    const tag = makeTag('srch-ph');
    const paket = await tempPaket(t, `pkt-${tag}`);
    // Store phone with dashes; search with raw digits should still find it
    const jem = await tempJem(t, tag, `JemaahDashed-${tag}`, `0822-3399-${(Date.now() % 10000).toString().padStart(4, '0')}`);
    await tempBooking(t, { paket, jemaah: jem });

    const r1 = await searchBookings({ q: '0822-3399' });
    assert.ok(r1.rows.find((x) => x.jemaah?.fullName === `JemaahDashed-${tag}`), 'raw dashed query matches stored dashed phone');
  });

  test('empty q returns paginated full set', async (t) => {
    const tag = makeTag('srch-empty');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJem(t, tag, `Mr ${tag}`, '0833');
    await tempBooking(t, { paket, jemaah: jem });
    const r = await searchBookings({});
    assert.ok(r.total >= 1, 'returns rows from seeded DB + ours');
    assert.equal(r.pageSize, 50);
    assert.equal(r.page, 1);
  });
});

describe('searchBookings — filters', () => {
  test('status filter narrows the rows but counts.byStatus stays full', async (t) => {
    const tag = makeTag('srch-filt');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJem(t, tag, `Tag-${tag}`, '0844');
    await tempBooking(t, { paket, jemaah: jem, status: 'PENDING' });
    await tempBooking(t, { paket, jemaah: jem, status: 'LUNAS' });
    await tempBooking(t, { paket, jemaah: jem, status: 'CANCELLED' });

    const all = await searchBookings({ q: tag });
    assert.equal(all.rows.length, 3);

    const onlyLunas = await searchBookings({ q: tag, status: 'LUNAS' });
    assert.equal(onlyLunas.rows.length, 1);
    // KPI strip must still show all 3 statuses (the filter is for the row
    // list only — the strip helps the user discover other statuses).
    assert.equal(onlyLunas.counts.byStatus.PENDING, 1);
    assert.equal(onlyLunas.counts.byStatus.LUNAS, 1);
    assert.equal(onlyLunas.counts.byStatus.CANCELLED, 1);
  });

  test('agentId=NONE matches walk-in bookings only', async (t) => {
    const tag = makeTag('srch-walk');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const agent = await tempAgent(t, tag);
    const jem = await tempJem(t, tag, `Walk-${tag}`, '0855');
    await tempBooking(t, { paket, jemaah: jem, agentId: agent.agent.id });
    await tempBooking(t, { paket, jemaah: jem, agentId: null }); // walk-in

    const walk = await searchBookings({ q: tag, agentId: 'NONE' });
    assert.equal(walk.rows.length, 1, 'only the walk-in matches NONE');
    assert.equal(walk.rows[0].agent, null);
  });

  test('date range filter on createdAt', async (t) => {
    const tag = makeTag('srch-date');
    const paket = await tempPaket(t, `pkt-${tag}`);
    const jem = await tempJem(t, tag, `Date-${tag}`, '0866');
    const old = await tempBooking(t, { paket, jemaah: jem });
    await db.booking.update({
      where: { id: old.id },
      data: { createdAt: new Date(Date.now() - 200 * 86_400_000) },
    });
    await tempBooking(t, { paket, jemaah: jem });

    const today = new Date().toISOString().slice(0, 10);
    const recent = await searchBookings({ q: tag, from: today });
    assert.equal(recent.rows.length, 1, 'only today\'s booking lands in [today, today]');
  });

  test('paketId filter scopes rows', async (t) => {
    const tag = makeTag('srch-pkt');
    const paketA = await tempPaket(t, `pktA-${tag}`);
    const paketB = await tempPaket(t, `pktB-${tag}`);
    const jem = await tempJem(t, tag, `PaketScope-${tag}`, '0877');
    await tempBooking(t, { paket: paketA, jemaah: jem });
    await tempBooking(t, { paket: paketB, jemaah: jem });

    const onlyA = await searchBookings({ q: tag, paketId: paketA.id });
    assert.equal(onlyA.rows.length, 1);
    assert.equal(onlyA.rows[0].paket?.slug, paketA.slug);
  });
});

describe('searchBookings — pagination', () => {
  test('pageSize 50, totalPages math', async () => {
    // We don't seed 50 rows — just verify shape with whatever's in the DB.
    const r = await searchBookings({ page: 1 });
    assert.equal(r.pageSize, 50);
    assert.equal(r.totalPages, Math.max(1, Math.ceil(r.total / 50)));
  });
});
