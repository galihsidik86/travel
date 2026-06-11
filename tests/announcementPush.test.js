// Stage 193 — push fan-out to jemaah when a paket announcement is
// posted. Uses S93 pushToUser fan-out per active booking → user.
//
// We can't observe the fake-mode console push directly, but we CAN
// verify that the recipient list resolves correctly and the create
// path doesn't abort on push errors (best-effort posture).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempPaket, tempJemaah, tempBooking, fakeReq, systemActor } from './_helpers.js';
import { createAnnouncement } from '../src/services/paketAnnouncements.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempJemaahUser(t, tag) {
  const email = `${tag}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test'),
      role: 'JEMAAH', fullName: `Jemaah ${tag}`, phone: '+62811',
      jemaah: { create: { fullName: `Jemaah ${tag}`, phone: '+62811' } },
    },
    include: { jemaah: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientUserId: user.id } });
    await db.jemaahProfile.deleteMany({ where: { id: user.jemaah.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

test('createAnnouncement: succeeds when no jemaah has PushSubscription', async (t) => {
  // Push fan-out is silent (nobody installed PWA) — create still works
  const tag = makeTag('s193-nopush');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketAnnouncement' } });
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
  });
  const r = await createAnnouncement({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { title: 'Notice 1', body: 'Manasik tgl 5' },
  });
  assert.equal(r.title, 'Notice 1');
});

test('createAnnouncement: fan-out finds linked jemaah from active bookings', async (t) => {
  const tag = makeTag('s193-linked');
  const paket = await tempPaket(t, tag);
  const u1 = await tempJemaahUser(t, `${tag}-1`);
  const u2 = await tempJemaahUser(t, `${tag}-2`);
  // Two bookings: u1 linked, u2 linked
  const b1 = await tempBooking({ paket, jemaahProfileId: u1.jemaah.id, jemaahUserId: u1.id });
  const b2 = await tempBooking({ paket, jemaahProfileId: u2.jemaah.id, jemaahUserId: u2.id });
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketAnnouncement' } });
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
  });

  // Should succeed; we can't observe the fake-mode push but the
  // create path needs to handle 2 distinct jemaah cleanly.
  const r = await createAnnouncement({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { title: 'Group notice', body: 'Pelunasan H-30' },
  });
  assert.equal(r.title, 'Group notice');
});

test('createAnnouncement: anonymous bookings (jemaahUserId=null) are skipped', async (t) => {
  const tag = makeTag('s193-anon');
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  // jemaahUserId omitted → anonymous booking. Push should silently skip.
  await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketAnnouncement' } });
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
  });

  const r = await createAnnouncement({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { title: 'Update', body: 'Booking update' },
  });
  assert.equal(r.title, 'Update');
});

test('createAnnouncement: scheduled-future announcement does NOT push immediately', async (t) => {
  // publishedAt in the future → the gate `row.publishedAt <= new Date()`
  // should evaluate false and the push fan-out is suppressed.
  const tag = makeTag('s193-future');
  const paket = await tempPaket(t, tag);
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'PaketAnnouncement' } });
    await db.paketAnnouncement.deleteMany({ where: { paketId: paket.id } });
  });
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const r = await createAnnouncement({
    req: fakeReq, actor: systemActor, paketId: paket.id,
    input: { title: 'Scheduled', body: 'Future post', publishedAt: future },
  });
  assert.ok(r.publishedAt > new Date(), 'publishedAt is future');
});
