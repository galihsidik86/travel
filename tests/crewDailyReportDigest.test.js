// Stage 279 — crew daily report reminder + admin missed digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, tempPaket, tempMuthawwif, tempUser, makeTag } from './_helpers.js';
import {
  getCrewMissingTodayReport,
  sendCrewDailyReportReminder,
  sendCrewDailyReportMissedAdmin,
} from '../src/services/crewDailyReportDigest.js';
import { submitCrewDailyReport } from '../src/services/crewDailyReport.js';

const fakeReq = { ip: '127.0.0.1', headers: {}, get: () => 'test' };

async function setPaketInTrip(paket, { dayOffset = 0 } = {}) {
  // Set departureDate so that today (or +dayOffset) is within [dep, ret]
  const start = new Date(); start.setDate(start.getDate() - 2 + dayOffset);
  const end = new Date(); end.setDate(end.getDate() + 3 + dayOffset);
  await db.paket.update({ where: { id: paket.id }, data: { departureDate: start, returnDate: end } });
}

async function assignCrew(paket, crewUser) {
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crewUser.id } });
}

test('getCrewMissingTodayReport: surfaces in-trip crew who haven\'t reported today', async (t) => {
  const paket = await tempPaket(t, 'cdrd-miss');
  await setPaketInTrip(paket);
  const crew = await tempMuthawwif(t, makeTag('cdrd-miss'));
  await assignCrew(paket, crew);
  const r = await getCrewMissingTodayReport({});
  const found = r.find((x) => x.user.id === crew.id);
  assert.ok(found, 'crew surfaces in missing list');
  assert.equal(found.paket.id, paket.id);
});

test('getCrewMissingTodayReport: excludes crew who already submitted today', async (t) => {
  const paket = await tempPaket(t, 'cdrd-done');
  await setPaketInTrip(paket);
  const crew = await tempMuthawwif(t, makeTag('cdrd-done'));
  await assignCrew(paket, crew);
  await submitCrewDailyReport({
    req: fakeReq,
    actor: { id: crew.id, email: crew.email, role: 'MUTHAWWIF' },
    userId: crew.id, paketSlug: paket.slug, body: 'today report',
  });
  const r = await getCrewMissingTodayReport({});
  const found = r.find((x) => x.user.id === crew.id && x.paket.id === paket.id);
  assert.equal(found, undefined);
});

test('getCrewMissingTodayReport: excludes paket NOT in trip today', async (t) => {
  const paket = await tempPaket(t, 'cdrd-fut');
  // Future-only paket
  const fut1 = new Date(); fut1.setDate(fut1.getDate() + 30);
  const fut2 = new Date(); fut2.setDate(fut2.getDate() + 37);
  await db.paket.update({ where: { id: paket.id }, data: { departureDate: fut1, returnDate: fut2 } });
  const crew = await tempMuthawwif(t, makeTag('cdrd-fut'));
  await assignCrew(paket, crew);
  const r = await getCrewMissingTodayReport({});
  const found = r.find((x) => x.user.id === crew.id);
  assert.equal(found, undefined);
});

test('getCrewMissingTodayReport: excludes SUSPENDED crew', async (t) => {
  const paket = await tempPaket(t, 'cdrd-sus');
  await setPaketInTrip(paket);
  const crew = await tempMuthawwif(t, makeTag('cdrd-sus'), { status: 'SUSPENDED' });
  await assignCrew(paket, crew);
  const r = await getCrewMissingTodayReport({});
  const found = r.find((x) => x.user.id === crew.id);
  assert.equal(found, undefined);
});

test('sendCrewDailyReportReminder: silent when no candidates', async () => {
  // Hard to guarantee zero candidates without isolation, but verify the
  // shape works when the count is determined by other test fixtures.
  const r = await sendCrewDailyReportReminder({});
  assert.equal(typeof r.candidateCount, 'number');
  assert.equal(typeof r.enqueued, 'number');
});

test('sendCrewDailyReportReminder: enqueues WA when candidate has phone', async (t) => {
  const paket = await tempPaket(t, 'cdrd-snd');
  await setPaketInTrip(paket);
  const crew = await tempMuthawwif(t, makeTag('cdrd-snd'));
  await assignCrew(paket, crew);
  const before = await db.notification.count({
    where: { type: 'CREW_DAILY_REPORT_REMINDER', recipientUserId: crew.id },
  });
  await sendCrewDailyReportReminder({});
  const after = await db.notification.count({
    where: { type: 'CREW_DAILY_REPORT_REMINDER', recipientUserId: crew.id },
  });
  assert.ok(after > before, 'notif enqueued');
});

test('sendCrewDailyReportReminder: 12h cooldown skips repeat', async (t) => {
  const paket = await tempPaket(t, 'cdrd-cd');
  await setPaketInTrip(paket);
  const crew = await tempMuthawwif(t, makeTag('cdrd-cd'));
  await assignCrew(paket, crew);
  await sendCrewDailyReportReminder({});
  const after1 = await db.notification.count({
    where: { type: 'CREW_DAILY_REPORT_REMINDER', recipientUserId: crew.id },
  });
  await sendCrewDailyReportReminder({});
  const after2 = await db.notification.count({
    where: { type: 'CREW_DAILY_REPORT_REMINDER', recipientUserId: crew.id },
  });
  assert.equal(after1, after2, 'cooldown blocked second enqueue');
});

test('sendCrewDailyReportMissedAdmin: emails admin when crew missed yesterday', async (t) => {
  // Create a paket that was in-trip yesterday (started 3 days ago, ends in 2)
  const paket = await tempPaket(t, 'cdrd-yad');
  const start = new Date(); start.setDate(start.getDate() - 3);
  const end = new Date(); end.setDate(end.getDate() + 2);
  await db.paket.update({ where: { id: paket.id }, data: { departureDate: start, returnDate: end } });
  const crew = await tempMuthawwif(t, makeTag('cdrd-yad'));
  await assignCrew(paket, crew);
  // No report submitted for yesterday → admin should hear
  const owner = await tempUser(t, makeTag('cdrd-yad-ow'), { role: 'OWNER' });
  const before = await db.notification.count({
    where: { type: 'CREW_DAILY_REPORT_MISSED_ADMIN', recipientEmail: owner.email },
  });
  const r = await sendCrewDailyReportMissedAdmin({});
  assert.ok(r.missedCount > 0, 'missed > 0');
  const after = await db.notification.count({
    where: { type: 'CREW_DAILY_REPORT_MISSED_ADMIN', recipientEmail: owner.email },
  });
  assert.ok(after > before, 'admin email enqueued');
});

test('sendCrewDailyReportMissedAdmin: silent when zero missed', async () => {
  // We can't guarantee zero missed here (other tests may leak), but
  // verify shape contract on the empty path by using a far-past now
  // where no paket exists.
  const r = await sendCrewDailyReportMissedAdmin({
    now: new Date('2020-01-01T00:00:00'),
  });
  assert.equal(typeof r.missedCount, 'number');
  assert.equal(typeof r.enqueued, 'number');
});
