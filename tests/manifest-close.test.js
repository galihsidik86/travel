// Stage 43 — manifest close countdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket } from './_helpers.js';
import { getManifestClosing, extendManifestClose } from '../src/services/manifestClose.js';

const ONE_HOUR_MS = 60 * 60_000;

test('paket without manifestClosesAt are excluded', async (t) => {
  const tag = makeTag('mc-noclose');
  const paket = await tempPaket(t, tag);
  // Default tempPaket leaves manifestClosesAt null
  const out = await getManifestClosing();
  assert.ok(!out.rows.some((r) => r.slug === paket.slug));
});

test('paket closing within urgentHours appear with positive hoursUntilClose', async (t) => {
  const tag = makeTag('mc-urgent');
  const paket = await tempPaket(t, tag);
  const closeAt = new Date(Date.now() + 12 * ONE_HOUR_MS);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: closeAt },
  });
  const out = await getManifestClosing();
  const row = out.rows.find((r) => r.slug === paket.slug);
  assert.ok(row);
  assert.equal(row.overdue, false);
  assert.ok(row.hoursUntilClose >= 11 && row.hoursUntilClose <= 13);
});

test('paket with closes-at in the past flag overdue=true', async (t) => {
  const tag = makeTag('mc-overdue');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: new Date(Date.now() - 5 * ONE_HOUR_MS) },
  });
  const out = await getManifestClosing();
  const row = out.rows.find((r) => r.slug === paket.slug);
  assert.ok(row);
  assert.equal(row.overdue, true);
  assert.ok(row.hoursUntilClose < 0);
});

test('full paket excluded (close-at irrelevant once kursi penuh)', async (t) => {
  const tag = makeTag('mc-full');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: {
      manifestClosesAt: new Date(Date.now() + 12 * ONE_HOUR_MS),
      kursiTerisi: paket.kursiTotal, // fully booked
    },
  });
  const out = await getManifestClosing();
  assert.ok(!out.rows.some((r) => r.slug === paket.slug));
});

test('extendManifestClose adds N hours to the existing close date', async (t) => {
  const tag = makeTag('mc-extend');
  const paket = await tempPaket(t, tag);
  const original = new Date(Date.now() + 6 * ONE_HOUR_MS);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: original },
  });

  const updated = await extendManifestClose({ slug: paket.slug, hours: 24 });
  assert.ok(updated);
  const expected = original.getTime() + 24 * ONE_HOUR_MS;
  assert.ok(Math.abs(updated.manifestClosesAt.getTime() - expected) < 2000);
});

test('extendManifestClose on overdue paket extends from now (not from past)', async (t) => {
  const tag = makeTag('mc-extend-overdue');
  const paket = await tempPaket(t, tag);
  const overdueDate = new Date(Date.now() - 24 * ONE_HOUR_MS);
  await db.paket.update({
    where: { id: paket.id },
    data: { manifestClosesAt: overdueDate },
  });

  const updated = await extendManifestClose({ slug: paket.slug, hours: 48 });
  // Extension must land in the future (~48h from now), not 24h from now
  // (which would be the result of naively adding 48h to the past date)
  const ahead = updated.manifestClosesAt.getTime() - Date.now();
  assert.ok(ahead > 47 * ONE_HOUR_MS, `expected ~48h ahead, got ${ahead / ONE_HOUR_MS}h`);
});

test('extendManifestClose returns null for unknown slug', async () => {
  const r = await extendManifestClose({ slug: 'definitely-not-there-zzz', hours: 24 });
  assert.equal(r, null);
});
