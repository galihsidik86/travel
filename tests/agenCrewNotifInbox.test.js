// Stage 148 — unread notif badge + inbox for /agen + /crew. Mirrors
// the S5rr jemaah inbox: countUnreadForUser is role-agnostic
// (recipientUserId-scoped) so AGEN + MUTHAWWIF users see their own
// notif count + mark-read on inbox open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { db, makeTag, tempUser, tempMuthawwif } from './_helpers.js';
import {
  countUnreadForUser, markAllReadForUser, listMyNotifications,
} from '../src/services/jemaahPortal.js';
import { hashPassword } from '../src/lib/auth.js';

async function tempAgentUser(t, tag) {
  const email = `${tag}-agen@example.test`;
  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'),
      role: 'AGEN', fullName: `Agen ${tag}`, phone: '+62811',
      agent: {
        create: {
          displayName: `Agen ${tag}`, slug: tag, tier: 'BRONZE',
          whatsapp: '+62811',
        },
      },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientUserId: user.id } });
    await db.agentProfile.deleteMany({ where: { id: user.agent.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  });
  return user;
}

async function seedNotif({ user, channel = 'EMAIL', type = 'PAYOUT_CREATED', readAt = null }) {
  return db.notification.create({
    data: {
      type, channel, status: 'SENT',
      recipientUserId: user.id,
      subject: 'test subject',
      body: 'test body',
      sentAt: new Date(),
      readAt,
    },
  });
}

test('countUnreadForUser: works for AGEN user', async (t) => {
  const tag = makeTag('s148-agen-count');
  const agen = await tempAgentUser(t, tag);

  await seedNotif({ user: agen });
  await seedNotif({ user: agen });
  await seedNotif({ user: agen, readAt: new Date() });  // already read — not counted

  const count = await countUnreadForUser(agen.id);
  assert.equal(count, 2);
});

test('countUnreadForUser: works for MUTHAWWIF user', async (t) => {
  const tag = makeTag('s148-crew-count');
  const crew = await tempMuthawwif(t, tag);

  await seedNotif({ user: crew, type: 'CREW_WEEKLY_DIGEST' });
  await seedNotif({ user: crew, type: 'CREW_WEEKLY_DIGEST' });
  t.after(() => db.notification.deleteMany({ where: { recipientUserId: crew.id } }));

  const count = await countUnreadForUser(crew.id);
  assert.equal(count, 2);
});

test('markAllReadForUser: clears unread for any role', async (t) => {
  const tag = makeTag('s148-mark');
  const agen = await tempAgentUser(t, tag);

  await seedNotif({ user: agen });
  await seedNotif({ user: agen });
  await seedNotif({ user: agen });

  await markAllReadForUser(agen.id);
  const stillUnread = await countUnreadForUser(agen.id);
  assert.equal(stillUnread, 0);

  // All rows now have readAt stamped
  const rows = await db.notification.findMany({ where: { recipientUserId: agen.id } });
  assert.ok(rows.every((r) => r.readAt instanceof Date));
});

test('listMyNotifications: returns role-agnostic — finds notifs for AGEN', async (t) => {
  const tag = makeTag('s148-list-agen');
  const agen = await tempAgentUser(t, tag);

  await seedNotif({ user: agen, type: 'PAYOUT_CREATED' });
  await seedNotif({ user: agen, type: 'AGENT_WEEKLY_DIGEST' });

  const rows = await listMyNotifications(agen.id);
  // At least our 2 are present
  const types = rows.map((r) => r.type);
  assert.ok(types.includes('PAYOUT_CREATED'));
  assert.ok(types.includes('AGENT_WEEKLY_DIGEST'));
});

test('inbox load → markAllRead → next count is 0', async (t) => {
  // Integration-style: seed unread → snapshot list → mark-all-read.
  // The snapshot still carries readAt:null (view sees them as unread
  // for the highlight), but next countUnreadForUser is 0.
  const tag = makeTag('s148-flow');
  const crew = await tempMuthawwif(t, tag);
  await seedNotif({ user: crew, type: 'CREW_WEEKLY_DIGEST' });
  await seedNotif({ user: crew, type: 'CREW_WEEKLY_DIGEST' });
  t.after(() => db.notification.deleteMany({ where: { recipientUserId: crew.id } }));

  const snapshot = await listMyNotifications(crew.id);
  const unreadCountInSnapshot = snapshot.filter((n) => n.readAt == null).length;
  assert.ok(unreadCountInSnapshot >= 2, 'snapshot keeps null readAt for highlight');

  await markAllReadForUser(crew.id);
  const after = await countUnreadForUser(crew.id);
  assert.equal(after, 0);
});
