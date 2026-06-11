// Stage 203 — daily passport renewal reminder. Targets jemaah whose
// passportExpiry is within 90 days. 30-day cooldown.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag } from './_helpers.js';
import {
  getPassportRenewalCandidates, sendPassportRenewalReminders,
  DEFAULT_WINDOW_DAYS, DEFAULT_COOLDOWN_DAYS,
} from '../src/services/passportRenewalReminder.js';
import { notifyPassportRenewal } from '../src/services/notifications.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempJemaahWithUser(t, tag, { passportExpiry, notifEmail = true } = {}) {
  const email = `${tag}-${Math.random().toString(36).slice(2, 5)}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'JEMAAH', fullName: `J ${tag}`, phone: '+62811',
      jemaah: { create: {
        fullName: `J ${tag}`, phone: '+62811',
        passportNo: `A${Math.floor(Math.random() * 10000000)}`,
        passportExpiry, notifEmail,
      } },
    },
    include: { jemaah: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'JemaahProfile', relatedEntityId: user.jemaah.id } });
    await db.notification.deleteMany({ where: { recipientUserId: user.id } });
    await db.jemaahProfile.deleteMany({ where: { id: user.jemaah.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('exported constants sane', () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 90);
  assert.equal(DEFAULT_COOLDOWN_DAYS, 30);
});

test('notifyPassportRenewal: silent when no contact info', async () => {
  const r = await notifyPassportRenewal({
    jemaah: {
      id: 'x', fullName: 'J', passportNo: 'X1', passportExpiry: new Date(),
      user: null, phone: null,
    },
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_contact');
});

test('getPassportRenewalCandidates: picks jemaah with passport expiring <90d', async (t) => {
  const tag = makeTag('s203-pick');
  // Passport expires in 60 days
  const expiry = new Date(Date.now() + 60 * 24 * 60 * 60_000);
  const u = await tempJemaahWithUser(t, tag, { passportExpiry: expiry });

  const { rows } = await getPassportRenewalCandidates({});
  const mine = rows.find((r) => r.id === u.jemaah.id);
  assert.ok(mine, 'jemaah found');
  assert.ok(mine.daysLeft >= 59 && mine.daysLeft <= 61, 'daysLeft computed');
});

test('getPassportRenewalCandidates: excludes passport expiring >90d', async (t) => {
  const tag = makeTag('s203-far');
  // Passport expires in 200 days — outside window
  const expiry = new Date(Date.now() + 200 * 24 * 60 * 60_000);
  const u = await tempJemaahWithUser(t, tag, { passportExpiry: expiry });

  const { rows } = await getPassportRenewalCandidates({});
  const mine = rows.find((r) => r.id === u.jemaah.id);
  assert.equal(mine, undefined);
});

test('getPassportRenewalCandidates: excludes jemaah with null passportExpiry', async (t) => {
  const tag = makeTag('s203-null');
  const u = await tempJemaahWithUser(t, tag, { passportExpiry: null });

  const { rows } = await getPassportRenewalCandidates({});
  const mine = rows.find((r) => r.id === u.jemaah.id);
  assert.equal(mine, undefined);
});

test('getPassportRenewalCandidates: respects notifEmail opt-out', async (t) => {
  const tag = makeTag('s203-optout');
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  const u = await tempJemaahWithUser(t, tag, {
    passportExpiry: expiry, notifEmail: false,
  });
  const { rows } = await getPassportRenewalCandidates({});
  const mine = rows.find((r) => r.id === u.jemaah.id);
  assert.equal(mine, undefined, 'opted-out jemaah skipped');
});

test('getPassportRenewalCandidates: cooldown excludes recently-nudged', async (t) => {
  const tag = makeTag('s203-cool');
  const expiry = new Date(Date.now() + 50 * 24 * 60 * 60_000);
  const u = await tempJemaahWithUser(t, tag, { passportExpiry: expiry });
  await db.notification.create({
    data: {
      type: 'PASSPORT_RENEWAL_REMINDER', channel: 'EMAIL', status: 'SENT',
      recipientEmail: u.email, body: 'prior nudge',
      relatedEntity: 'JemaahProfile', relatedEntityId: u.jemaah.id,
      sentAt: new Date(),
    },
  });
  const { rows } = await getPassportRenewalCandidates({ cooldownDays: 30 });
  const mine = rows.find((r) => r.id === u.jemaah.id);
  assert.equal(mine, undefined);
});

test('sendPassportRenewalReminders: end-to-end enqueues both EMAIL + WA', async (t) => {
  const tag = makeTag('s203-e2e');
  const expiry = new Date(Date.now() + 45 * 24 * 60 * 60_000);
  const u = await tempJemaahWithUser(t, tag, { passportExpiry: expiry });

  const r = await sendPassportRenewalReminders({});
  assert.ok(r.enqueued >= 1, 'at least one enqueued');

  const notifs = await db.notification.findMany({
    where: { type: 'PASSPORT_RENEWAL_REMINDER', recipientUserId: u.id },
  });
  // Both EMAIL + WA channels enqueued (jemaah has both)
  assert.equal(notifs.length, 2);
  const channels = new Set(notifs.map((n) => n.channel));
  assert.ok(channels.has('EMAIL'));
  assert.ok(channels.has('WA'));
});

test('sendPassportRenewalReminders: empty candidates → quiet zero', async () => {
  const r = await sendPassportRenewalReminders({
    now: new Date('1990-01-01'), // far past — no jemaah has expiry < 90d
  });
  assert.equal(r.jemaahCount, 0);
  assert.equal(r.enqueued, 0);
});

test('getPassportRenewalCandidates: sorted soonest-expiring first', async (t) => {
  const tag = makeTag('s203-sort');
  const expiryA = new Date(Date.now() + 30 * 24 * 60 * 60_000); // 30d
  const expiryB = new Date(Date.now() + 80 * 24 * 60 * 60_000); // 80d
  const uA = await tempJemaahWithUser(t, `${tag}-A`, { passportExpiry: expiryA });
  const uB = await tempJemaahWithUser(t, `${tag}-B`, { passportExpiry: expiryB });

  const { rows } = await getPassportRenewalCandidates({});
  const idxA = rows.findIndex((r) => r.id === uA.jemaah.id);
  const idxB = rows.findIndex((r) => r.id === uB.jemaah.id);
  assert.ok(idxA >= 0 && idxB >= 0, 'both found');
  assert.ok(idxA < idxB, '30d expiry sorts before 80d');
});
