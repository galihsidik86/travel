// Stage 137 — per-crew incident rate-limit (5 per 10min). SOS type
// bypasses the limit — life-safety always lands. Fail-open on store
// errors (lifeline must not silently drop).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempMuthawwif, tempPaket, fakeReq } from './_helpers.js';
import { createIncident } from '../src/services/incidents.js';
import { setRateLimitStore } from '../src/middleware/rateLimit.js';
import { makeMemoryStore } from '../src/lib/rateLimitStore.js';
import { HttpError } from '../src/middleware/error.js';

test('createIncident: non-SOS types capped at 5 per 10min per crew', async (t) => {
  const tag = makeTag('s137-cap');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });

  setRateLimitStore(makeMemoryStore({ windowMs: 60_000 }));
  t.after(() => setRateLimitStore(null));
  t.after(() => db.incident.deleteMany({ where: { createdById: crew.id } }));

  // 5 MEDICAL incidents should all succeed
  for (let i = 0; i < 5; i++) {
    await createIncident({
      req: fakeReq, crewUser: crew,
      input: { type: 'MEDICAL', paketSlug: paket.slug, message: `m${i}` },
    });
  }
  // 6th should be throttled
  await assert.rejects(
    () => createIncident({
      req: fakeReq, crewUser: crew,
      input: { type: 'MEDICAL', paketSlug: paket.slug, message: 'm6' },
    }),
    (err) => err instanceof HttpError && err.status === 429 && err.code === 'SOS_THROTTLED',
  );

  const created = await db.incident.count({ where: { createdById: crew.id } });
  assert.equal(created, 5, '6th create rejected — only 5 rows landed');
});

test('createIncident: SOS bypasses the rate-limit (life-safety always lands)', async (t) => {
  const tag = makeTag('s137-sos');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });

  setRateLimitStore(makeMemoryStore({ windowMs: 60_000 }));
  t.after(() => setRateLimitStore(null));
  t.after(() => db.incident.deleteMany({ where: { createdById: crew.id } }));

  // Burn through the non-SOS cap first
  for (let i = 0; i < 5; i++) {
    await createIncident({
      req: fakeReq, crewUser: crew,
      input: { type: 'LOGISTICAL', paketSlug: paket.slug, message: `l${i}` },
    });
  }
  // SOS should still go through — 7 attempts, all succeed
  for (let i = 0; i < 7; i++) {
    await createIncident({
      req: fakeReq, crewUser: crew,
      input: { type: 'SOS', paketSlug: paket.slug, message: `sos${i}` },
    });
  }
  const sosCount = await db.incident.count({
    where: { createdById: crew.id, type: 'SOS' },
  });
  assert.equal(sosCount, 7, 'all SOS incidents landed despite quota burnout');
});

test('createIncident: fail-open on store error (lifeline must not drop)', async (t) => {
  const tag = makeTag('s137-failopen');
  const crew = await tempMuthawwif(t, tag);
  const paket = await tempPaket(t, tag);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });

  // Broken store — every .hit() throws (simulates Redis blip)
  setRateLimitStore({
    kind: 'broken',
    hit: async () => { throw new Error('store down'); },
    stop: async () => {},
  });
  t.after(() => setRateLimitStore(null));
  t.after(() => db.incident.deleteMany({ where: { createdById: crew.id } }));

  // Non-SOS should still go through (fail-open)
  for (let i = 0; i < 3; i++) {
    await createIncident({
      req: fakeReq, crewUser: crew,
      input: { type: 'MEDICAL', paketSlug: paket.slug, message: `m${i}` },
    });
  }
  const count = await db.incident.count({ where: { createdById: crew.id } });
  assert.equal(count, 3, 'fail-open allowed all 3 non-SOS through');
});

test('createIncident: per-crew bucket — one crew throttled doesnt block another', async (t) => {
  const tag = makeTag('s137-isolated');
  const crewA = await tempMuthawwif(t, `${tag}-a`);
  const crewB = await tempMuthawwif(t, `${tag}-b`);
  const paket = await tempPaket(t, tag);
  await db.paketCrew.createMany({
    data: [
      { paketId: paket.id, userId: crewA.id },
      { paketId: paket.id, userId: crewB.id },
    ],
  });

  setRateLimitStore(makeMemoryStore({ windowMs: 60_000 }));
  t.after(() => setRateLimitStore(null));
  t.after(async () => {
    await db.incident.deleteMany({ where: { createdById: { in: [crewA.id, crewB.id] } } });
  });

  // Crew A maxes out
  for (let i = 0; i < 5; i++) {
    await createIncident({
      req: fakeReq, crewUser: crewA,
      input: { type: 'MEDICAL', paketSlug: paket.slug, message: `a${i}` },
    });
  }
  // Crew B should be unaffected
  await createIncident({
    req: fakeReq, crewUser: crewB,
    input: { type: 'MEDICAL', paketSlug: paket.slug, message: 'b1' },
  });
  const bCount = await db.incident.count({ where: { createdById: crewB.id } });
  assert.equal(bCount, 1);
});
