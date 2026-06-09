// Stage 133 — Booking.referrerHost snapshot at create time + conversion%
// in getReferrerBreakdown. Closes the gap S132 explicitly deferred.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, fakeReq } from './_helpers.js';
import { createBooking } from '../src/services/booking.js';
import { recordPaketView, getVisitorAttribution, getReferrerBreakdown } from '../src/services/paketView.js';

test('getVisitorAttribution: returns referrerHost from first-touch view', async (t) => {
  const tag = makeTag('s133-attr');
  const paket = await tempPaket(t, tag);
  const visitorId = 'c1d2e3f4567890123456789012345abc';

  // First view via fb.com, later via google — first-touch wins
  await recordPaketView({ paketId: paket.id, visitorId, referrerHost: 'fb.com' });
  // Different dayKey so the upsert creates a 2nd row
  await recordPaketView({
    paketId: paket.id, visitorId, referrerHost: 'google.com',
    now: new Date(Date.now() + 86400_000),
  });

  const attr = await getVisitorAttribution({ paketId: paket.id, visitorId });
  assert.equal(attr.referrerHost, 'fb.com', 'first-touch wins');
  assert.equal(attr.viewCount, 2);
});

test('createBooking: snapshots referrerHost on Booking row', async (t) => {
  const tag = makeTag('s133-create');
  const paket = await tempPaket(t, tag);

  const booking = await createBooking({
    req: fakeReq,
    paketSlug: paket.slug,
    fullName: 'Test Convert',
    phone: '+62811',
    kelas: 'QUAD',
    paxCount: 1,
    visitorAttribution: {
      firstViewAt: new Date(),
      viewCount: 3,
      heroVariant: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      referrerHost: 'instagram.com',
    },
  });
  assert.equal(booking.booking.referrerHost, 'instagram.com');
});

test('createBooking: missing visitorAttribution → referrerHost = null (backwards compat)', async (t) => {
  const tag = makeTag('s133-nullattr');
  const paket = await tempPaket(t, tag);

  const booking = await createBooking({
    req: fakeReq,
    paketSlug: paket.slug,
    fullName: 'Test Direct',
    phone: '+62811',
    kelas: 'QUAD',
    paxCount: 1,
    // visitorAttribution omitted
  });
  assert.equal(booking.booking.referrerHost, null);
});

test('getReferrerBreakdown: computes bookings + conversionPct per host', async (t) => {
  const tag = makeTag('s133-conv');
  const paket = await tempPaket(t, tag);

  // 10 visits via fb.com, 2 bookings → 20% conversion
  // Visitor IDs need 32 unique hex chars — put index FIRST so a long
  // tag doesn't truncate the differentiator out.
  const baseHex = '0123456789abcdef';
  for (let i = 0; i < 10; i++) {
    const vid = (baseHex + baseHex)            // 32-char hex base
      .slice(0, 32 - 2) + i.toString().padStart(2, '0');
    await recordPaketView({
      paketId: paket.id,
      visitorId: vid,
      referrerHost: 'fb.com',
    });
  }
  for (let i = 0; i < 2; i++) {
    await createBooking({
      req: fakeReq, paketSlug: paket.slug,
      fullName: `FB Conv ${i}`, phone: '+62811',
      kelas: 'QUAD', paxCount: 1,
      visitorAttribution: {
        firstViewAt: new Date(), viewCount: 1, heroVariant: null,
        utmSource: null, utmMedium: null, utmCampaign: null,
        referrerHost: 'fb.com',
      },
    });
  }

  const r = await getReferrerBreakdown({ days: 7 });
  const fb = r.rows.find((row) => row.referrerHost === 'fb.com');
  assert.ok(fb, 'fb.com row present');
  assert.ok(fb.visits >= 10, `visits ≥ 10 (got ${fb.visits})`);
  assert.ok(fb.bookings >= 2, `bookings ≥ 2 (got ${fb.bookings})`);
  // Conversion is bookings/visits (rounded 0.1)
  assert.ok(fb.conversionPct >= 10, `conversionPct should reflect bookings/visits (got ${fb.conversionPct})`);
});

test('getReferrerBreakdown: conversionPct=null when visits=0 but bookings>0', async (t) => {
  // Simulates a pre-S132 booking that was attribution-stamped via
  // direct API path (no corresponding PaketView row).
  const tag = makeTag('s133-blind');
  const paket = await tempPaket(t, tag);

  await createBooking({
    req: fakeReq, paketSlug: paket.slug,
    fullName: 'Blind Conv', phone: '+62811',
    kelas: 'QUAD', paxCount: 1,
    visitorAttribution: {
      firstViewAt: new Date(), viewCount: 0, heroVariant: null,
      utmSource: null, utmMedium: null, utmCampaign: null,
      referrerHost: 'traffic-blind.example',
    },
  });

  const r = await getReferrerBreakdown({ days: 7 });
  const blind = r.rows.find((row) => row.referrerHost === 'traffic-blind.example');
  assert.ok(blind);
  assert.equal(blind.visits, 0);
  assert.equal(blind.bookings, 1);
  assert.equal(blind.conversionPct, null, 'null avoids divide-by-zero / misleading ∞');
});
