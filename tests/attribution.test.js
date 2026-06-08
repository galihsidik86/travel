// Stages 49/50/51 — attribution snapshot from paket views onto bookings.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket } from './_helpers.js';
import { pickHeroVariant, recordPaketView, getVisitorAttribution, getPaketABBreakdown, getUtmBreakdown } from '../src/services/paketView.js';
import { createBooking } from '../src/services/booking.js';

const fakeReq = { ip: '127.0.0.1', headers: {} };

test('pickHeroVariant: even-first-hex → A, odd → B (stable per visitor)', () => {
  assert.equal(pickHeroVariant('0' + 'a'.repeat(31)), 'A'); // 0 = even
  assert.equal(pickHeroVariant('2' + 'a'.repeat(31)), 'A'); // 2 = even
  assert.equal(pickHeroVariant('1' + 'a'.repeat(31)), 'B'); // 1 = odd
  assert.equal(pickHeroVariant('f' + 'a'.repeat(31)), 'B'); // 15 = odd
  // Stable: same input → same output
  const id = 'd' + 'eadbeef'.repeat(4);
  assert.equal(pickHeroVariant(id), pickHeroVariant(id));
});

test('getVisitorAttribution returns null when no views exist', async (t) => {
  const tag = makeTag('attr-empty');
  const paket = await tempPaket(t, tag);
  const r = await getVisitorAttribution({ paketId: paket.id, visitorId: 'x'.repeat(32) });
  assert.equal(r, null);
});

test('getVisitorAttribution: first-touch UTM + view count from existing rows', async (t) => {
  const tag = makeTag('attr-first');
  const paket = await tempPaket(t, tag);
  const visitorId = 'a'.repeat(32);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });

  // 3 visits across 3 days — only the FIRST should set UTM/variant
  await recordPaketView({
    paketId: paket.id, visitorId, heroVariant: 'A',
    utm: { source: 'fb', medium: 'cpc', campaign: 'ramadhan' },
  });
  // Force the day-key forward by overwriting dayKey via direct insert
  await db.paketView.create({
    data: {
      paketId: paket.id, visitorId,
      dayKey: '2099-12-30',                  // far future, definitely > first
      heroVariant: 'B',                       // admin swapped variant mid-test
      utmSource: null, utmMedium: null,
    },
  });

  const r = await getVisitorAttribution({ paketId: paket.id, visitorId });
  assert.equal(r.viewCount, 2);
  assert.ok(r.firstViewAt);
  // UTM comes from oldest row (first-touch)
  assert.equal(r.utmSource, 'fb');
  assert.equal(r.utmCampaign, 'ramadhan');
  // heroVariant prefers the most-recent non-null (what they saw when they converted)
  assert.equal(r.heroVariant, 'B');
});

test('createBooking snapshots attribution from visitorAttribution arg', async (t) => {
  const tag = makeTag('attr-book');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  // Add a synthetic price tier so totalAmount calculation works
  await db.paketHarga.upsert({
    where: { paketId_kelas: { paketId: paket.id, kelas: 'QUAD' } },
    update: { priceIdr: '1000000' },
    create: { paketId: paket.id, kelas: 'QUAD', priceIdr: '1000000' },
  });
  const attribution = {
    firstViewAt: new Date(Date.now() - 5 * 86_400_000),
    viewCount: 3,
    heroVariant: 'B',
    utmSource: 'ig',
    utmMedium: 'organic',
    utmCampaign: 'umroh-2027',
  };

  const { booking } = await createBooking({
    req: fakeReq, paketSlug: paket.slug,
    fullName: 'Attr Test', phone: '+62811',
    kelas: 'QUAD', paxCount: 1,
    visitorAttribution: attribution,
  });

  const row = await db.booking.findUnique({
    where: { id: booking.id },
    select: { firstViewAt: true, viewCount: true, heroVariant: true, utmSource: true, utmCampaign: true },
  });
  assert.equal(row.viewCount, 3);
  assert.equal(row.heroVariant, 'B');
  assert.equal(row.utmSource, 'ig');
  assert.equal(row.utmCampaign, 'umroh-2027');
  assert.ok(row.firstViewAt);
});

test('createBooking without visitorAttribution → default zero/null columns', async (t) => {
  const tag = makeTag('attr-none');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paketHarga.upsert({
    where: { paketId_kelas: { paketId: paket.id, kelas: 'QUAD' } },
    update: { priceIdr: '1000000' },
    create: { paketId: paket.id, kelas: 'QUAD', priceIdr: '1000000' },
  });
  const { booking } = await createBooking({
    req: fakeReq, paketSlug: paket.slug,
    fullName: 'No Attr', phone: '+62811',
    kelas: 'QUAD', paxCount: 1,
  });
  const row = await db.booking.findUnique({
    where: { id: booking.id },
    select: { firstViewAt: true, viewCount: true, heroVariant: true, utmSource: true },
  });
  assert.equal(row.firstViewAt, null);
  assert.equal(row.viewCount, 0);
  assert.equal(row.heroVariant, null);
  assert.equal(row.utmSource, null);
});

test('getPaketABBreakdown: pre-30-visit threshold returns winner=null', async (t) => {
  const tag = makeTag('ab-small');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  // 10 visits A, 10 visits B (well below 30 threshold)
  for (let i = 0; i < 10; i++) {
    await recordPaketView({
      paketId: paket.id, visitorId: 'a'.repeat(31) + i.toString(16),
      heroVariant: 'A',
    });
  }
  for (let i = 0; i < 10; i++) {
    await recordPaketView({
      paketId: paket.id, visitorId: 'b'.repeat(31) + i.toString(16),
      heroVariant: 'B',
    });
  }
  const r = await getPaketABBreakdown({ paketId: paket.id });
  assert.equal(r.A.visits, 10);
  assert.equal(r.B.visits, 10);
  assert.equal(r.winner, null, 'must NOT declare a winner with <30 visits');
});

test('getUtmBreakdown buckets rows by (source, medium, campaign)', async (t) => {
  const tag = makeTag('utm-bk');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.paketView.deleteMany({ where: { paketId: paket.id } });
  });
  await recordPaketView({
    paketId: paket.id, visitorId: 'a'.repeat(32),
    utm: { source: 'tiktok', medium: 'video', campaign: 'live-jan' },
  });
  await recordPaketView({
    paketId: paket.id, visitorId: 'b'.repeat(32),
    utm: { source: 'tiktok', medium: 'video', campaign: 'live-jan' },
  });
  await recordPaketView({
    paketId: paket.id, visitorId: 'c'.repeat(32),
    // no UTM → direct bucket
  });

  const r = await getUtmBreakdown();
  const tiktok = r.rows.find((row) => row.source === 'tiktok' && row.campaign === 'live-jan');
  assert.ok(tiktok);
  assert.ok(tiktok.visits >= 2);
  const direct = r.rows.find((row) => row.isDirect);
  assert.ok(direct, 'direct/no-UTM bucket must appear');
});
