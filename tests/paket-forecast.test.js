// Stage 40 — per-paket forecast tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempJemaah, tempPaket, tempBooking } from './_helpers.js';
import { getPaketForecasts } from '../src/services/paketForecast.js';

const ONE_DAY_MS = 86_400_000;

test('returns rows for ACTIVE + future-departure paket only', async (t) => {
  const tag = makeTag('fc-shape');
  const future = await tempPaket(t, `${tag}-fut`);
  // Soft-delete an ACTIVE paket — must NOT appear
  const gone = await tempPaket(t, `${tag}-gone`);
  await db.paket.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

  const out = await getPaketForecasts();
  const slugs = out.map((r) => r.paket.slug);
  assert.ok(slugs.includes(future.slug), 'ACTIVE + future paket must appear');
  assert.ok(!slugs.includes(gone.slug), 'soft-deleted paket must be excluded');
});

test('zero recent activity → noVelocity=true and dtfDays=null', async (t) => {
  const tag = makeTag('fc-novel');
  const paket = await tempPaket(t, tag);
  const out = await getPaketForecasts();
  const row = out.find((r) => r.paket.slug === paket.slug);
  assert.ok(row);
  assert.equal(row.velocity, 0);
  assert.equal(row.noVelocity, true);
  assert.equal(row.dtfDays, null);
});

test('full paket (kursiTerisi >= kursiTotal) → full=true and dtfDays=0', async (t) => {
  const tag = makeTag('fc-full');
  const paket = await tempPaket(t, tag);
  await db.paket.update({
    where: { id: paket.id },
    data: { kursiTerisi: paket.kursiTotal },
  });
  const out = await getPaketForecasts();
  const row = out.find((r) => r.paket.slug === paket.slug);
  assert.equal(row.full, true);
  assert.equal(row.dtfDays, 0);
  assert.equal(row.seatsRemaining, 0);
});

test('velocity from 14d bookings → dtfDays computed from remaining/velocity', async (t) => {
  const tag = makeTag('fc-velo');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  // kursiTotal=10 (helper default), kursiTerisi=0 → 10 seats remaining
  // Create 7 bookings spread across last 7 days → mean velocity ≈ 0.5/day
  for (let i = 0; i < 7; i++) {
    const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
    await db.booking.update({
      where: { id: b.id },
      data: { createdAt: new Date(Date.now() - (i + 1) * ONE_DAY_MS + 1000) },
    });
  }
  const out = await getPaketForecasts();
  const row = out.find((r) => r.paket.slug === paket.slug);
  assert.ok(row);
  assert.equal(row.full, false);
  assert.equal(row.noVelocity, false);
  // 7 bookings / 14d window = 0.5/day mean
  assert.ok(row.velocity > 0.4 && row.velocity < 0.6, `velocity was ${row.velocity}`);
  // 10 seats / 0.5/day = 20 days
  assert.ok(row.dtfDays >= 18 && row.dtfDays <= 22, `dtfDays was ${row.dtfDays}`);
  // Low and high bounds must straddle the mean
  assert.ok(row.dtfLowDays <= row.dtfDays);
  assert.ok(row.dtfHighDays >= row.dtfDays);
});

test('CANCELLED bookings do not contribute to velocity', async (t) => {
  const tag = makeTag('fc-cancel');
  const jem = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);

  // 3 CANCELLED bookings 3 days ago → must NOT bump velocity
  for (let i = 0; i < 3; i++) {
    const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
    await db.booking.update({
      where: { id: b.id },
      data: {
        createdAt: new Date(Date.now() - 3 * ONE_DAY_MS),
        status: 'CANCELLED', cancelledAt: new Date(),
      },
    });
  }
  const out = await getPaketForecasts();
  const row = out.find((r) => r.paket.slug === paket.slug);
  assert.equal(row.velocity, 0, 'CANCELLED must not contribute');
  assert.equal(row.noVelocity, true);
});

test('sort order: full rows first, then by dtfDays ascending, no-velocity last', async (t) => {
  const tag = makeTag('fc-sort');
  const jem = await tempJemaah(t, tag);

  // Three paket: one full, one with high velocity (low dtf), one with no activity
  const full = await tempPaket(t, `${tag}-full`);
  await db.paket.update({ where: { id: full.id }, data: { kursiTerisi: full.kursiTotal } });

  const fast = await tempPaket(t, `${tag}-fast`);
  for (let i = 0; i < 10; i++) {
    const b = await tempBooking({ paket: fast, jemaahProfileId: jem.jemaah.id });
    await db.booking.update({
      where: { id: b.id },
      data: { createdAt: new Date(Date.now() - (i % 7 + 1) * ONE_DAY_MS) },
    });
  }
  const idle = await tempPaket(t, `${tag}-idle`);

  const out = await getPaketForecasts();
  const ours = out.filter((r) => r.paket.slug.startsWith(`pkt-${tag}`) || r.paket.slug.startsWith(tag));
  const ourSlugs = ours.map((r) => r.paket.slug);
  // full must come before idle (full has dtfDays=0, idle is noVelocity)
  const fullIdx = ourSlugs.indexOf(full.slug);
  const idleIdx = ourSlugs.indexOf(idle.slug);
  if (fullIdx !== -1 && idleIdx !== -1) {
    assert.ok(fullIdx < idleIdx, 'full must sort before noVelocity');
  }
});
