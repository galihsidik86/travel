// Stage 132 — PaketView referrer-host attribution.
// parseReferrerHost normalises Referer header → host bucket. Drops
// same-origin (in-site nav). Drops www. so fb.com / www.fb.com collapse.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket } from './_helpers.js';
import { parseReferrerHost, recordPaketView, getReferrerBreakdown } from '../src/services/paketView.js';

test('parseReferrerHost: normalises common Facebook/Google referrers', () => {
  assert.equal(parseReferrerHost('https://www.facebook.com/share/123'), 'facebook.com');
  assert.equal(parseReferrerHost('https://www.google.com/search?q=umrah'), 'google.com');
  assert.equal(parseReferrerHost('https://l.instagram.com/?u=...'), 'l.instagram.com');
  assert.equal(parseReferrerHost('https://t.co/abc'), 't.co');
});

test('parseReferrerHost: strips www. prefix', () => {
  assert.equal(parseReferrerHost('https://www.example.com/'), 'example.com');
  // But not "www2." or "wwwx." — exact "www." only
  assert.equal(parseReferrerHost('https://www2.example.com/'), 'www2.example.com');
});

test('parseReferrerHost: same-origin → null (in-site nav drops out)', () => {
  // Treat in-site refresh / nav as "direct" (no useful attribution)
  assert.equal(parseReferrerHost('https://religio.pro/saya', 'religio.pro'), null);
  assert.equal(parseReferrerHost('https://www.religio.pro/p/x', 'religio.pro'), null);
  // ownHost may include port — split before compare
  assert.equal(parseReferrerHost('http://localhost:3001/admin', 'localhost:3001'), null);
});

test('parseReferrerHost: null / malformed / missing → null', () => {
  assert.equal(parseReferrerHost(null), null);
  assert.equal(parseReferrerHost(''), null);
  assert.equal(parseReferrerHost('not a url'), null);
  assert.equal(parseReferrerHost(123), null);
});

test('parseReferrerHost: long hosts cap at 120 chars (DB column width)', () => {
  const longHost = 'a'.repeat(200) + '.example.com';
  const out = parseReferrerHost(`https://${longHost}/`);
  assert.ok(out.length <= 120);
});

test('recordPaketView: stores referrerHost on first visit', async (t) => {
  const tag = makeTag('pvR-store');
  const paket = await tempPaket(t, tag);
  const visitorId = 'a1b2c3d4e5f6789012345678901234ff';

  await recordPaketView({
    paketId: paket.id, visitorId,
    referrerHost: 'fb.com',
  });
  const row = await db.paketView.findFirst({ where: { paketId: paket.id, visitorId } });
  assert.equal(row.referrerHost, 'fb.com');
});

test('recordPaketView: first-touch wins — repeat visit same day keeps original referrer', async (t) => {
  const tag = makeTag('pvR-firsttouch');
  const paket = await tempPaket(t, tag);
  const visitorId = 'b2c3d4e5f67890123456789012345678';

  // First visit via fb.com
  await recordPaketView({
    paketId: paket.id, visitorId,
    referrerHost: 'fb.com',
  });
  // Same-day repeat with a different referrer should NOT overwrite
  await recordPaketView({
    paketId: paket.id, visitorId,
    referrerHost: 'google.com',
  });
  const rows = await db.paketView.findMany({ where: { paketId: paket.id, visitorId } });
  assert.equal(rows.length, 1, 'still one row per day (unique constraint)');
  assert.equal(rows[0].referrerHost, 'fb.com', 'first-touch wins');
});

test('getReferrerBreakdown: groups visits by referrerHost with isDirect for nulls', async (t) => {
  const tag = makeTag('pvR-break');
  const paket = await tempPaket(t, tag);

  // Three visitors via fb.com, two via google, one direct
  for (let i = 0; i < 3; i++) {
    await recordPaketView({
      paketId: paket.id,
      visitorId: `fb${i.toString().padStart(30, '0')}`,
      referrerHost: 'fb.com',
    });
  }
  for (let i = 0; i < 2; i++) {
    await recordPaketView({
      paketId: paket.id,
      visitorId: `gg${i.toString().padStart(30, '0')}`,
      referrerHost: 'google.com',
    });
  }
  await recordPaketView({
    paketId: paket.id,
    visitorId: 'direct' + '0'.repeat(26),
    referrerHost: null,
  });

  const r = await getReferrerBreakdown({ days: 7 });
  const fb = r.rows.find((row) => row.referrerHost === 'fb.com');
  const gg = r.rows.find((row) => row.referrerHost === 'google.com');
  const direct = r.rows.find((row) => row.isDirect);
  assert.ok(fb && fb.visits >= 3);
  assert.ok(gg && gg.visits >= 2);
  assert.ok(direct && direct.visits >= 1);
  assert.equal(direct.label, '(no referrer / direct)');
  // Sorted visits desc — fb (3) should appear before gg (2) before direct (1)
  const fbIdx = r.rows.indexOf(fb);
  const ggIdx = r.rows.indexOf(gg);
  assert.ok(fbIdx < ggIdx, 'higher visit count sorts first');
});
