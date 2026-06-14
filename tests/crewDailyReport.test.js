// Stage 277 — crew daily report.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempMuthawwif, makeTag } from './_helpers.js';
import {
  submitCrewDailyReport,
  listMyCrewReports,
  listPaketReports,
  getRecentReportTally,
} from '../src/services/crewDailyReport.js';

const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function assignCrew(paket, crewUser) {
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crewUser.id } });
}

function actorFor(u) {
  return { id: u.id, email: u.email, role: 'MUTHAWWIF' };
}

test('submitCrewDailyReport: 400 on short body', async (t) => {
  const paket = await tempPaket(t, 'cdr-bdy');
  const crew = await tempMuthawwif(t, makeTag('cdr-bdy'));
  await assignCrew(paket, crew);
  await assert.rejects(
    () => submitCrewDailyReport({
      req: fakeReq, actor: actorFor(crew),
      userId: crew.id, paketSlug: paket.slug, body: 'x',
    }),
    (err) => err.code === 'REPORT_BODY_REQUIRED' && err.status === 400,
  );
});

test('submitCrewDailyReport: 400 on too-long body', async (t) => {
  const paket = await tempPaket(t, 'cdr-lng');
  const crew = await tempMuthawwif(t, makeTag('cdr-lng'));
  await assignCrew(paket, crew);
  await assert.rejects(
    () => submitCrewDailyReport({
      req: fakeReq, actor: actorFor(crew),
      userId: crew.id, paketSlug: paket.slug, body: 'a'.repeat(4001),
    }),
    (err) => err.code === 'REPORT_BODY_TOO_LONG' && err.status === 400,
  );
});

test('submitCrewDailyReport: 400 on invalid mood', async (t) => {
  const paket = await tempPaket(t, 'cdr-mood');
  const crew = await tempMuthawwif(t, makeTag('cdr-mood'));
  await assignCrew(paket, crew);
  await assert.rejects(
    () => submitCrewDailyReport({
      req: fakeReq, actor: actorFor(crew),
      userId: crew.id, paketSlug: paket.slug, body: 'valid body', mood: 'PURPLE',
    }),
    (err) => err.code === 'REPORT_BAD_MOOD' && err.status === 400,
  );
});

test('submitCrewDailyReport: 404 NOT_ASSIGNED when crew unassigned', async (t) => {
  const paket = await tempPaket(t, 'cdr-nas');
  const crew = await tempMuthawwif(t, makeTag('cdr-nas'));
  // intentionally NOT assigning
  await assert.rejects(
    () => submitCrewDailyReport({
      req: fakeReq, actor: actorFor(crew),
      userId: crew.id, paketSlug: paket.slug, body: 'valid body',
    }),
    (err) => err.code === 'NOT_ASSIGNED' && err.status === 404,
  );
});

test('submitCrewDailyReport: 404 NOT_ASSIGNED on unknown paket', async (t) => {
  const crew = await tempMuthawwif(t, makeTag('cdr-uk'));
  await assert.rejects(
    () => submitCrewDailyReport({
      req: fakeReq, actor: actorFor(crew),
      userId: crew.id, paketSlug: 'nope-slug-xxx', body: 'valid body',
    }),
    (err) => err.code === 'NOT_ASSIGNED' && err.status === 404,
  );
});

test('submitCrewDailyReport: creates a row + audit', async (t) => {
  const paket = await tempPaket(t, 'cdr-crt');
  const crew = await tempMuthawwif(t, makeTag('cdr-crt'));
  await assignCrew(paket, crew);
  const r = await submitCrewDailyReport({
    req: fakeReq, actor: actorFor(crew),
    userId: crew.id, paketSlug: paket.slug,
    body: 'hari pertama semua lancar', mood: 'GREEN',
  });
  assert.ok(r.id);
  assert.equal(r.mood, 'GREEN');
  assert.ok(r.body.includes('lancar'));
  const audit = await db.auditLog.findFirst({
    where: { entity: 'CrewDailyReport', entityId: r.id, action: 'CREATE' },
  });
  assert.ok(audit);
});

test('submitCrewDailyReport: re-submit upserts same row (composite unique)', async (t) => {
  const paket = await tempPaket(t, 'cdr-up');
  const crew = await tempMuthawwif(t, makeTag('cdr-up'));
  await assignCrew(paket, crew);
  const r1 = await submitCrewDailyReport({
    req: fakeReq, actor: actorFor(crew),
    userId: crew.id, paketSlug: paket.slug,
    body: 'first version', mood: 'GREEN',
  });
  const r2 = await submitCrewDailyReport({
    req: fakeReq, actor: actorFor(crew),
    userId: crew.id, paketSlug: paket.slug,
    body: 'second version', mood: 'AMBER',
  });
  // Same row id — upsert by composite unique
  assert.equal(r1.id, r2.id);
  assert.equal(r2.body, 'second version');
  assert.equal(r2.mood, 'AMBER');
  // Audit row exists for the update
  const audits = await db.auditLog.findMany({
    where: { entity: 'CrewDailyReport', entityId: r1.id },
    orderBy: { createdAt: 'asc' },
  });
  // CREATE + UPDATE
  assert.equal(audits.length, 2);
  assert.equal(audits[1].after.crewReportUpserted, true);
});

test('submitCrewDailyReport: computes dayNumber from departureDate', async (t) => {
  const paket = await tempPaket(t, 'cdr-dn');
  // Set departure 3 days ago so today is day 4
  const dep = new Date(); dep.setDate(dep.getDate() - 3);
  await db.paket.update({ where: { id: paket.id }, data: { departureDate: dep, returnDate: dep } });
  const crew = await tempMuthawwif(t, makeTag('cdr-dn'));
  await assignCrew(paket, crew);
  const r = await submitCrewDailyReport({
    req: fakeReq, actor: actorFor(crew),
    userId: crew.id, paketSlug: paket.slug, body: 'hari ke-4 berjalan baik',
  });
  // Day 1 = departureDate; today (= dep + 3) → day 4
  assert.equal(r.dayNumber, 4);
});

test('listMyCrewReports: returns only this crew\'s reports', async (t) => {
  const paket = await tempPaket(t, 'cdr-lst');
  const crewA = await tempMuthawwif(t, makeTag('cdr-lst-a'));
  const crewB = await tempMuthawwif(t, makeTag('cdr-lst-b'));
  await assignCrew(paket, crewA);
  await assignCrew(paket, crewB);
  await submitCrewDailyReport({
    req: fakeReq, actor: actorFor(crewA), userId: crewA.id, paketSlug: paket.slug, body: 'A report',
  });
  await submitCrewDailyReport({
    req: fakeReq, actor: actorFor(crewB), userId: crewB.id, paketSlug: paket.slug, body: 'B report',
  });
  const mineA = await listMyCrewReports({ userId: crewA.id, paketSlug: paket.slug });
  assert.equal(mineA.length, 1);
  assert.ok(mineA[0].body.includes('A report'));
});

test('listPaketReports: returns all crew reports for the paket', async (t) => {
  const paket = await tempPaket(t, 'cdr-all');
  const crewA = await tempMuthawwif(t, makeTag('cdr-all-a'));
  const crewB = await tempMuthawwif(t, makeTag('cdr-all-b'));
  await assignCrew(paket, crewA);
  await assignCrew(paket, crewB);
  await submitCrewDailyReport({
    req: fakeReq, actor: actorFor(crewA), userId: crewA.id, paketSlug: paket.slug, body: 'A report',
  });
  await submitCrewDailyReport({
    req: fakeReq, actor: actorFor(crewB), userId: crewB.id, paketSlug: paket.slug, body: 'B report',
  });
  const r = await listPaketReports({ paketSlug: paket.slug });
  assert.ok(r);
  assert.equal(r.reports.length, 2);
  // Includes crew identity for admin view
  assert.ok(r.reports[0].crewUser.email);
});

test('listPaketReports: returns null on unknown paket', async () => {
  const r = await listPaketReports({ paketSlug: 'nope-xxx' });
  assert.equal(r, null);
});

test('getRecentReportTally: returns per-mood counts shape', async () => {
  const r = await getRecentReportTally({ days: 7 });
  assert.equal(typeof r.tally.GREEN, 'number');
  assert.equal(typeof r.tally.AMBER, 'number');
  assert.equal(typeof r.tally.RED, 'number');
  assert.equal(r.days, 7);
  assert.equal(typeof r.total, 'number');
});
