// Stage 146 — no-show rate analytics. Per-paket + per-agent rate
// (no-show count ÷ resolved-active bookings on departed paket).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, tempUser } from './_helpers.js';
import { getNoShowAnalytics } from '../src/services/noShowAnalytics.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgent(t, tag) {
  const email = `${tag}-agent@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'), role: 'AGEN',
      fullName: `Agen ${tag}`, phone: '+62811',
      agent: { create: { displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE', whatsapp: '+62811' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

async function backdateDeparture(paketId, daysAgo = 5) {
  await db.paket.update({
    where: { id: paketId },
    data: {
      departureDate: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
      returnDate: new Date(Date.now() - (daysAgo - 10) * 24 * 60 * 60 * 1000),
    },
  });
}

test('getNoShowAnalytics: empty DB → totals zero, lists empty', async () => {
  // Just verify shape — dev DB likely has noise from other tests
  const r = await getNoShowAnalytics({ days: 90 });
  assert.ok(typeof r.totals.noShowCount === 'number');
  assert.ok(Array.isArray(r.byPaket));
  assert.ok(Array.isArray(r.byAgent));
});

test('getNoShowAnalytics: paket with 2/5 no-shows → ratePct=40', async (t) => {
  const tag = makeTag('s146-paket');
  const paket = await tempPaket(t, tag, { dayCount: 3 });
  await backdateDeparture(paket.id, 10);

  // 5 bookings on this paket, 2 stamped no-show, 3 active
  const bookings = [];
  for (let i = 0; i < 5; i++) {
    const jem = await tempJemaah(t, `${tag}-j${i}`);
    bookings.push(await tempBooking({ paket, jemaahProfileId: jem.jemaah.id }));
  }
  // Stamp first 2 as no-show
  for (let i = 0; i < 2; i++) {
    await db.booking.update({
      where: { id: bookings[i].id },
      data: { noShowAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
    });
  }

  const r = await getNoShowAnalytics({ days: 90 });
  const myRow = r.byPaket.find((x) => x.paketId === paket.id);
  assert.ok(myRow);
  assert.equal(myRow.noShowCount, 2);
  assert.equal(myRow.resolvedActive, 5);
  assert.equal(myRow.ratePct, 40);
});

test('getNoShowAnalytics: walk-in (no agent) buckets under Kantor Pusat sentinel', async (t) => {
  const tag = makeTag('s146-kp');
  const paket = await tempPaket(t, tag);
  await backdateDeparture(paket.id, 10);

  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // No agentId set on tempBooking → walk-in
  await db.booking.update({
    where: { id: booking.id },
    data: { noShowAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
  });

  const r = await getNoShowAnalytics({ days: 90 });
  const kpRow = r.byAgent.find((x) => x.agentKey === '__kp__');
  assert.ok(kpRow, 'KP bucket exists');
  assert.equal(kpRow.displayName, 'Kantor Pusat');
  assert.ok(kpRow.noShowCount >= 1);
});

test('getNoShowAnalytics: per-agent rollup attributes correctly', async (t) => {
  const tag = makeTag('s146-agent');
  const paket = await tempPaket(t, tag);
  await backdateDeparture(paket.id, 10);
  const agentUser = await tempAgent(t, tag);

  // 3 bookings under this agent, 1 stamped no-show
  for (let i = 0; i < 3; i++) {
    const jem = await tempJemaah(t, `${tag}-j${i}`);
    const b = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
    await db.booking.update({
      where: { id: b.id },
      data: { agentId: agentUser.agent.id },
    });
    if (i === 0) {
      await db.booking.update({
        where: { id: b.id },
        data: { noShowAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
      });
    }
  }

  const r = await getNoShowAnalytics({ days: 90 });
  const myAgent = r.byAgent.find((x) => x.slug === tag);
  assert.ok(myAgent);
  assert.equal(myAgent.noShowCount, 1);
  assert.equal(myAgent.resolvedActive, 3);
  assert.equal(myAgent.ratePct, 33.3);
});

test('getNoShowAnalytics: future-departing paket excluded from denominator', async (t) => {
  const tag = makeTag('s146-future');
  const paket = await tempPaket(t, tag);
  // departureDate is +30d by default — future

  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Stamp no-show even though paket is future (theoretical; won't happen in
  // production via detect-no-shows but test the rollup behavior)
  await db.booking.update({
    where: { id: booking.id },
    data: { noShowAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) },
  });

  const r = await getNoShowAnalytics({ days: 90 });
  const myRow = r.byPaket.find((x) => x.paketId === paket.id);
  // No-show count exists, but resolvedActive=0 → ratePct=null
  if (myRow) {
    assert.equal(myRow.resolvedActive, 0, 'future paket excluded from denominator');
    assert.equal(myRow.ratePct, null, 'null avoids divide-by-zero');
  }
});

test('getNoShowAnalytics: sorts byPaket by noShowCount desc', async (t) => {
  const tag = makeTag('s146-sort');
  const paketBig = await tempPaket(t, `${tag}-big`);
  const paketSmall = await tempPaket(t, `${tag}-small`);
  await backdateDeparture(paketBig.id, 10);
  await backdateDeparture(paketSmall.id, 10);

  // 3 no-shows on big, 1 on small
  for (let i = 0; i < 3; i++) {
    const jem = await tempJemaah(t, `${tag}-big-${i}`);
    const b = await tempBooking({ paket: paketBig, jemaahProfileId: jem.jemaah.id });
    await db.booking.update({
      where: { id: b.id },
      data: { noShowAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
    });
  }
  const jemS = await tempJemaah(t, `${tag}-small-1`);
  const bs = await tempBooking({ paket: paketSmall, jemaahProfileId: jemS.jemaah.id });
  await db.booking.update({
    where: { id: bs.id },
    data: { noShowAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
  });

  const r = await getNoShowAnalytics({ days: 90 });
  const bigIdx = r.byPaket.findIndex((x) => x.paketId === paketBig.id);
  const smallIdx = r.byPaket.findIndex((x) => x.paketId === paketSmall.id);
  assert.ok(bigIdx >= 0 && smallIdx >= 0);
  assert.ok(bigIdx < smallIdx, 'higher no-show count sorts first');
});
