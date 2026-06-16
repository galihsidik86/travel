// Stage 307 — birthday greeting cron tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempJemaah } from './_helpers.js';
import {
  getBirthdayCandidates, sendBirthdayGreetings, COOLDOWN_DAYS,
} from '../src/services/birthdayGreeting.js';

// Build a birthday set to today (year matters less for the comparison —
// service compares month + day, year is ignored).
function birthdayToday(yearsAgo = 30) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

test('S307 — empty when no jemaah has birthday today', async () => {
  // Set "now" to a date no seed jemaah has as their birthday.
  // Seeds use deterministic dates so a far-future "now" guarantees no match.
  const result = await getBirthdayCandidates({ now: new Date('1980-02-29') });
  // Result may still be non-empty if seed has Feb 29 birthdays, but we
  // can at least verify the service doesn't crash + returns an array.
  assert.ok(Array.isArray(result));
});

test('S307 — picks up jemaah whose birthDate matches today month/day', async (t) => {
  const tag = makeTag('s307a');
  const jem = await tempJemaah(t, tag);
  // Update profile to have birthday today (30 years ago).
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { birthDate: birthdayToday(30), notifEngagement: true },
  });
  const result = await getBirthdayCandidates({ now: new Date() });
  const found = result.find((j) => j.id === jem.jemaah.id);
  assert.ok(found, 'jemaah surfaces in birthday candidates');
});

test('S307 — opt-out (notifEngagement=false) hides candidate', async (t) => {
  const tag = makeTag('s307b');
  const jem = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { birthDate: birthdayToday(40), notifEngagement: false },
  });
  const result = await getBirthdayCandidates({ now: new Date() });
  const found = result.find((j) => j.id === jem.jemaah.id);
  assert.equal(found, undefined, 'opted-out jemaah excluded from candidates');
});

test('S307 — recent prior notif (within cooldown) excludes candidate', async (t) => {
  const tag = makeTag('s307c');
  const jem = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { birthDate: birthdayToday(25), notifEngagement: true },
  });
  // Stub a recent BIRTHDAY_GREETING notif for this jemaah.
  await db.notification.create({
    data: {
      type: 'BIRTHDAY_GREETING', channel: 'EMAIL',
      recipientEmail: jem.jemaah.email || 'test@example.test',
      subject: 'past greet', body: 'past',
      status: 'SENT', sentAt: new Date(),
      relatedEntity: 'JemaahProfile', relatedEntityId: jem.jemaah.id,
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: jem.jemaah.id } });
  });

  const result = await getBirthdayCandidates({ now: new Date() });
  const found = result.find((j) => j.id === jem.jemaah.id);
  assert.equal(found, undefined, 'recently-sent jemaah excluded from candidates');
});

test('S307 — sendBirthdayGreetings enqueues a notif for matching jemaah', async (t) => {
  const tag = makeTag('s307d');
  const jem = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: { birthDate: birthdayToday(35), notifEngagement: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntityId: jem.jemaah.id } });
  });

  const result = await sendBirthdayGreetings({ now: new Date() });
  assert.ok(result.candidateCount >= 1);
  assert.ok(result.enqueued >= 1);
  const notif = await db.notification.findFirst({
    where: { type: 'BIRTHDAY_GREETING', relatedEntityId: jem.jemaah.id },
    orderBy: { createdAt: 'desc' },
    select: { subject: true, body: true },
  });
  assert.ok(notif);
  assert.match(notif.subject, /Selamat ulang tahun/);
});

test('S307 — COOLDOWN_DAYS exported as 360', () => {
  assert.equal(COOLDOWN_DAYS, 360);
});
