// Stage 173 — daily email to jemaah whose tracked docs expire
// within 30 days. Groups all soon-expiring docs into one email per
// jemaah. Per-jemaah 7-day cooldown.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import {
  getDocExpiringCandidates, sendDocExpiringNudges,
  DEFAULT_WINDOW_DAYS, DEFAULT_COOLDOWN_DAYS,
} from '../src/services/docExpiringNudge.js';
import { notifyDocExpiringSoon } from '../src/services/notifications.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempJemaahWithUser(t, tag, { notifEmail = true } = {}) {
  const email = `${tag}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'JEMAAH', fullName: `Jemaah ${tag}`, phone: '+62811',
      jemaah: { create: { fullName: `Jemaah ${tag}`, phone: '+62811', notifEmail } },
    },
    include: { jemaah: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientUserId: user.id } });
    await db.notification.deleteMany({ where: { relatedEntity: 'JemaahProfile', relatedEntityId: user.jemaah.id } });
    await db.jemaahDocument.deleteMany({ where: { jemaahId: user.jemaah.id } });
    await db.jemaahProfile.deleteMany({ where: { id: user.jemaah.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

async function seedDoc(jemaahId, { type = 'PASSPORT', expiresIn = 14, status = 'VERIFIED' } = {}) {
  const expiresAt = expiresIn != null
    ? new Date(Date.now() + expiresIn * 86_400_000)
    : null;
  return db.jemaahDocument.create({
    data: { jemaahId, type, status, expiresAt },
  });
}

test('notifyDocExpiringSoon: silent when no email', async () => {
  const r = await notifyDocExpiringSoon({
    jemaah: { id: 'x', fullName: 'J', userId: null, user: null },
    docs: [{ type: 'PASSPORT', typeLabel: 'Paspor', expiresAt: new Date(), daysLeft: 5 }],
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_email');
});

test('getDocExpiringCandidates: picks jemaah with VERIFIED doc expiring <30d', async (t) => {
  const tag = makeTag('s173-pick');
  const u = await tempJemaahWithUser(t, tag);
  await seedDoc(u.jemaah.id, { expiresIn: 14 });

  const { rows } = await getDocExpiringCandidates({});
  const mine = rows.find((r) => r.jemaah.id === u.jemaah.id);
  assert.ok(mine, 'jemaah with expiring doc surfaced');
  assert.equal(mine.docs.length, 1);
  assert.equal(mine.docs[0].type, 'PASSPORT');
  assert.equal(mine.docs[0].typeLabel, 'Paspor');
});

test('getDocExpiringCandidates: groups multi-doc jemaah into one row', async (t) => {
  const tag = makeTag('s173-multi');
  const u = await tempJemaahWithUser(t, tag);
  await seedDoc(u.jemaah.id, { type: 'PASSPORT', expiresIn: 14 });
  await seedDoc(u.jemaah.id, { type: 'VISA_UMROH', expiresIn: 7 });

  const { rows } = await getDocExpiringCandidates({});
  const mine = rows.find((r) => r.jemaah.id === u.jemaah.id);
  assert.equal(mine.docs.length, 2);
  // Sorted soonest-first
  assert.equal(mine.docs[0].type, 'VISA_UMROH');
});

test('getDocExpiringCandidates: excludes REJECTED + EXPIRED status', async (t) => {
  const tag = makeTag('s173-rejected');
  const u = await tempJemaahWithUser(t, tag);
  await seedDoc(u.jemaah.id, { type: 'PASSPORT', status: 'REJECTED', expiresIn: 14 });
  await seedDoc(u.jemaah.id, { type: 'VISA_UMROH', status: 'EXPIRED', expiresIn: 14 });

  const { rows } = await getDocExpiringCandidates({});
  const mine = rows.find((r) => r.jemaah.id === u.jemaah.id);
  assert.equal(mine, undefined, 'REJECTED + EXPIRED docs do not trigger nudge');
});

test('getDocExpiringCandidates: excludes docs without expiresAt', async (t) => {
  const tag = makeTag('s173-noexp');
  const u = await tempJemaahWithUser(t, tag);
  await seedDoc(u.jemaah.id, { type: 'MARRIAGE_CERT', expiresIn: null });

  const { rows } = await getDocExpiringCandidates({});
  const mine = rows.find((r) => r.jemaah.id === u.jemaah.id);
  assert.equal(mine, undefined);
});

test('getDocExpiringCandidates: respects per-jemaah notifEmail opt-out', async (t) => {
  const tag = makeTag('s173-optout');
  const u = await tempJemaahWithUser(t, tag, { notifEmail: false });
  await seedDoc(u.jemaah.id, { expiresIn: 14 });

  const { rows } = await getDocExpiringCandidates({});
  const mine = rows.find((r) => r.jemaah.id === u.jemaah.id);
  assert.equal(mine, undefined, 'opted-out jemaah skipped');
});

test('getDocExpiringCandidates: cooldown excludes recently-nudged jemaah', async (t) => {
  const tag = makeTag('s173-cool');
  const u = await tempJemaahWithUser(t, tag);
  await seedDoc(u.jemaah.id, { expiresIn: 14 });
  await db.notification.create({
    data: {
      type: 'DOC_EXPIRING_SOON', channel: 'EMAIL', status: 'SENT',
      recipientEmail: u.email, body: 'prior',
      relatedEntity: 'JemaahProfile', relatedEntityId: u.jemaah.id,
      sentAt: new Date(),
    },
  });

  const { rows } = await getDocExpiringCandidates({ cooldownDays: 7 });
  const mine = rows.find((r) => r.jemaah.id === u.jemaah.id);
  assert.equal(mine, undefined);
});

test('sendDocExpiringNudges: end-to-end enqueues one email per jemaah', async (t) => {
  const tag = makeTag('s173-e2e');
  const u = await tempJemaahWithUser(t, tag);
  await seedDoc(u.jemaah.id, { type: 'PASSPORT', expiresIn: 14 });
  await seedDoc(u.jemaah.id, { type: 'VACCINE_MENINGITIS', expiresIn: 20 });

  const r = await sendDocExpiringNudges({});
  assert.ok(r.enqueued >= 1, 'enqueued at least one');

  const notifs = await db.notification.findMany({
    where: { type: 'DOC_EXPIRING_SOON', recipientUserId: u.id },
  });
  assert.equal(notifs.length, 1, 'one email per jemaah, not per doc');
  assert.match(notifs[0].body, /Paspor/);
  assert.match(notifs[0].body, /Vaksin Meningitis/);
});

test('exported constants sane', () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 30);
  assert.equal(DEFAULT_COOLDOWN_DAYS, 7);
});
