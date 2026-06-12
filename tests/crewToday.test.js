// Stage 246 — crew "Hari ini" dashboard widget.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempMuthawwif } from './_helpers.js';
import { getCrewToday } from '../src/services/crewToday.js';

async function makePaket(t, tag, { daysOut = 7, status = 'ACTIVE', durationDays = 5 } = {}) {
  const dep = new Date(Date.now() + daysOut * 86_400_000);
  const paket = await db.paket.create({
    data: {
      slug: tag, title: `Paket ${tag}`,
      departureDate: dep, returnDate: new Date(dep.getTime() + durationDays * 86_400_000),
      durationDays, inclusions: [], exclusions: [],
      kursiTotal: 10, kursiTerisi: 0, status,
    },
  });
  t.after(async () => {
    await db.incident.deleteMany({ where: { paketId: paket.id } });
    await db.paketDay.deleteMany({ where: { paketId: paket.id } });
    await db.paketCrew.deleteMany({ where: { paketId: paket.id } });
    await db.paket.deleteMany({ where: { id: paket.id } });
  });
  return paket;
}

async function assign(paket, crew) {
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
}

test('getCrewToday: empty shape for missing userId', async () => {
  const r = await getCrewToday({});
  assert.deepEqual(r, { departingSoon: [], attendanceDueToday: [], openIncidents: [] });
});

test('getCrewToday: paket departing within 48h surfaces', async (t) => {
  const tag = makeTag('s246-soon');
  const crew = await tempMuthawwif(t, tag);
  const paket = await makePaket(t, tag, { daysOut: 1 }); // tomorrow
  await assign(paket, crew);

  const r = await getCrewToday({ userId: crew.id });
  assert.equal(r.departingSoon.length, 1);
  assert.equal(r.departingSoon[0].id, paket.id);
});

test('getCrewToday: paket departing > 48h excluded', async (t) => {
  const tag = makeTag('s246-far');
  const crew = await tempMuthawwif(t, tag);
  const paket = await makePaket(t, tag, { daysOut: 7 });
  await assign(paket, crew);

  const r = await getCrewToday({ userId: crew.id });
  assert.equal(r.departingSoon.length, 0);
});

test('getCrewToday: ARCHIVED paket excluded from departingSoon', async (t) => {
  const tag = makeTag('s246-arch');
  const crew = await tempMuthawwif(t, tag);
  const paket = await makePaket(t, tag, { daysOut: 1, status: 'ARCHIVED' });
  await assign(paket, crew);

  const r = await getCrewToday({ userId: crew.id });
  assert.equal(r.departingSoon.length, 0);
});

test('getCrewToday: attendance day landing on TODAY surfaces with CTA', async (t) => {
  const tag = makeTag('s246-att');
  const crew = await tempMuthawwif(t, tag);
  // Paket departed yesterday (daysOut = -1); day 2 = today
  const paket = await makePaket(t, tag, { daysOut: -1, durationDays: 5 });
  await assign(paket, crew);
  const day2 = await db.paketDay.create({
    data: { paketId: paket.id, dayNumber: 2, title: 'Madinah ziarah', description: '—' },
  });

  const r = await getCrewToday({ userId: crew.id });
  const todayDay = r.attendanceDueToday.find((a) => a.day.id === day2.id);
  assert.ok(todayDay, 'attendance day for today should surface');
  assert.equal(todayDay.day.dayNumber, 2);
});

test('getCrewToday: attendance day in past or future excluded', async (t) => {
  const tag = makeTag('s246-att-other');
  const crew = await tempMuthawwif(t, tag);
  const paket = await makePaket(t, tag, { daysOut: -1, durationDays: 10 });
  await assign(paket, crew);
  // Day 1 = yesterday (past), Day 5 = +4 days (future)
  const day1 = await db.paketDay.create({
    data: { paketId: paket.id, dayNumber: 1, title: 'Day 1', description: '—' },
  });
  const day5 = await db.paketDay.create({
    data: { paketId: paket.id, dayNumber: 5, title: 'Day 5', description: '—' },
  });

  const r = await getCrewToday({ userId: crew.id });
  // Neither day1 nor day5 should land in attendanceDueToday
  const idsToday = r.attendanceDueToday.map((a) => a.day.id);
  assert.ok(!idsToday.includes(day1.id));
  assert.ok(!idsToday.includes(day5.id));
});

test('getCrewToday: OPEN incidents from last 7d surface', async (t) => {
  const tag = makeTag('s246-inc');
  const crew = await tempMuthawwif(t, tag);
  const paket = await makePaket(t, tag, { daysOut: 7 });
  await assign(paket, crew);
  await db.incident.create({
    data: {
      paketId: paket.id, createdById: crew.id,
      type: 'MEDICAL', status: 'OPEN',
      message: 'jemaah sakit perut',
    },
  });

  const r = await getCrewToday({ userId: crew.id });
  assert.equal(r.openIncidents.length, 1);
  assert.equal(r.openIncidents[0].status, 'OPEN');
});

test('getCrewToday: RESOLVED incidents NOT surfaced', async (t) => {
  const tag = makeTag('s246-resolved');
  const crew = await tempMuthawwif(t, tag);
  const paket = await makePaket(t, tag, { daysOut: 7 });
  await assign(paket, crew);
  await db.incident.create({
    data: {
      paketId: paket.id, createdById: crew.id,
      type: 'LOST_JEMAAH', status: 'RESOLVED',
      message: 'lost, found 2h later',
      resolvedAt: new Date(),
      resolution: 'found at masjid entry',
    },
  });

  const r = await getCrewToday({ userId: crew.id });
  assert.equal(r.openIncidents.length, 0);
});

test('getCrewToday: incidents older than 7d excluded', async (t) => {
  const tag = makeTag('s246-old');
  const crew = await tempMuthawwif(t, tag);
  const paket = await makePaket(t, tag, { daysOut: 7 });
  await assign(paket, crew);
  await db.incident.create({
    data: {
      paketId: paket.id, createdById: crew.id,
      type: 'MEDICAL', status: 'OPEN',
      message: 'old',
      createdAt: new Date(Date.now() - 30 * 86_400_000),
    },
  });

  const r = await getCrewToday({ userId: crew.id });
  assert.equal(r.openIncidents.length, 0);
});

test('getCrewToday: other crew\'s incidents NOT in my list', async (t) => {
  const tag = makeTag('s246-isolate');
  const me = await tempMuthawwif(t, tag + '-me');
  const other = await tempMuthawwif(t, tag + '-other');
  const paket = await makePaket(t, tag, { daysOut: 7 });
  await assign(paket, me);
  await assign(paket, other);
  await db.incident.create({
    data: {
      paketId: paket.id, createdById: other.id,
      type: 'MEDICAL', status: 'OPEN',
      message: 'other crew incident',
    },
  });

  const r = await getCrewToday({ userId: me.id });
  // me's list should NOT include other's incident
  assert.equal(r.openIncidents.length, 0);
});
