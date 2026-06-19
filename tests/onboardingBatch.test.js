// Stage 379-381 — Onboarding fundamentals:
//   S379 Welcome checklist for new jemaah
//   S380 First-booking nudge cron
//   S381 Agen first-deal coaching widget

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { db, makeTag, tempJemaah } from './_helpers.js';
import { hashPassword } from '../src/lib/auth.js';

// ── S379 — Welcome checklist ──────────────────────────────────

test('S379 — getJemaahWelcomeChecklist returns null for non-JEMAAH', async () => {
  const { getJemaahWelcomeChecklist } = await import('../src/services/jemaahWelcomeChecklist.js');
  // Use a real OWNER user from seed (or any non-jemaah). Find one.
  const owner = await db.user.findFirst({ where: { role: 'OWNER' }, select: { id: true } });
  if (!owner) return; // skip if no seed
  const result = await getJemaahWelcomeChecklist(owner.id);
  assert.equal(result, null, 'non-JEMAAH returns null');
});

test('S379 — empty jemaah profile gets 0/3 server-known done', async (t) => {
  const tag = makeTag('s379a');
  const jem = await tempJemaah(t, tag);
  const { getJemaahWelcomeChecklist } = await import('../src/services/jemaahWelcomeChecklist.js');
  const result = await getJemaahWelcomeChecklist(jem.id);
  assert.ok(result);
  assert.equal(result.items.length, 4);
  // 4 items: profile, passport, emergency, pwa (pwa.done is null — client-side)
  assert.equal(result.serverTotal, 3);
  assert.equal(result.serverDone, 0); // brand new profile, nothing filled
  // PWA item has done=null
  const pwa = result.items.find((i) => i.key === 'pwa');
  assert.equal(pwa.done, null);
});

test('S379 — filled jemaah profile marks items done', async (t) => {
  const tag = makeTag('s379b');
  const jem = await tempJemaah(t, tag);
  await db.jemaahProfile.update({
    where: { id: jem.jemaah.id },
    data: {
      nik: '1234567890123456',
      birthDate: new Date('1990-01-01'),
      address: 'Jl. Test 123, Jakarta',
      emergencyContact: '+62811222333',
    },
  });
  await db.jemaahDocument.create({
    data: { jemaahId: jem.jemaah.id, type: 'PASSPORT', refNumber: 'A1234567', status: 'PENDING' },
  });
  const { getJemaahWelcomeChecklist } = await import('../src/services/jemaahWelcomeChecklist.js');
  const result = await getJemaahWelcomeChecklist(jem.id);
  assert.equal(result.serverDone, 3); // profile + passport + emergency
  // (pwa still null on server — view computes)
});

test('S379 — view renders checklist card when welcome is non-null', async () => {
  const src = await fs.readFile('./views/jemaah-portal.ejs', 'utf8');
  assert.match(src, /rp-welcome-card/);
  assert.match(src, /rp-welcome-dismiss/);
  // PWA install detected client-side via display-mode standalone
  assert.match(src, /display-mode: standalone/);
  // Dismiss persists in localStorage
  assert.match(src, /rp_welcome_dismissed/);
});

// ── S380 — First-booking nudge ────────────────────────────────

test('S380 — JEMAAH_FIRST_BOOKING_NUDGE enum exists in schema', async () => {
  const schema = await fs.readFile('./prisma/schema.prisma', 'utf8');
  assert.match(schema, /JEMAAH_FIRST_BOOKING_NUDGE/);
});

test('S380 — getFirstBookingNudgeCandidates filters old + no-booking users', async (t) => {
  const tag = makeTag('s380a');
  // Create a jemaah registered 10 days ago
  const oldDate = new Date(Date.now() - 10 * 86_400_000);
  const oldJem = await db.user.create({
    data: {
      email: `${tag}-old@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'JEMAAH', fullName: 'Old Jemaah', phone: '+628110001',
      createdAt: oldDate,
      jemaah: { create: { fullName: 'Old Jemaah', phone: '+628110001', email: `${tag}-old@example.test` } },
    },
  });
  // And a fresh jemaah registered 2 days ago (should NOT appear)
  const newJem = await db.user.create({
    data: {
      email: `${tag}-new@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'JEMAAH', fullName: 'New Jemaah', phone: '+628110002',
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      jemaah: { create: { fullName: 'New Jemaah', phone: '+628110002', email: `${tag}-new@example.test` } },
    },
  });
  t.after(async () => {
    for (const u of [oldJem, newJem]) {
      await db.notification.deleteMany({ where: { recipientUserId: u.id } });
      await db.jemaahProfile.deleteMany({ where: { userId: u.id } });
      await db.user.delete({ where: { id: u.id } });
    }
  });

  const { getFirstBookingNudgeCandidates } = await import('../src/services/firstBookingNudge.js');
  const cands = await getFirstBookingNudgeCandidates({});
  const ids = cands.map((c) => c.id);
  assert.ok(ids.includes(oldJem.id), 'old jemaah is candidate');
  assert.ok(!ids.includes(newJem.id), '2-day-old jemaah is NOT candidate');
});

test('S380 — sendFirstBookingNudges is terminal (one nudge per user, ever)', async (t) => {
  const tag = makeTag('s380b');
  const oldDate = new Date(Date.now() - 10 * 86_400_000);
  const jem = await db.user.create({
    data: {
      email: `${tag}@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'JEMAAH', fullName: 'Test Jemaah', phone: '+628110099',
      createdAt: oldDate,
      jemaah: { create: { fullName: 'Test Jemaah', phone: '+628110099', email: `${tag}@example.test`, notifEngagement: true } },
    },
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { recipientUserId: jem.id } });
    await db.jemaahProfile.deleteMany({ where: { userId: jem.id } });
    await db.user.delete({ where: { id: jem.id } });
  });

  const { sendFirstBookingNudges } = await import('../src/services/firstBookingNudge.js');
  const r1 = await sendFirstBookingNudges({});
  // Should pick up jem (no bookings, >7d old, opt-in)
  assert.ok(r1.candidateCount >= 1);
  assert.ok(r1.enqueued >= 1); // EMAIL + WA → 2

  // Second run: jem is already nudged (terminal cooldown), should NOT re-pick
  const r2 = await sendFirstBookingNudges({});
  const candidatesIncludeUser = (await import('../src/services/firstBookingNudge.js'))
    .getFirstBookingNudgeCandidates({}).then((c) => c.some((x) => x.id === jem.id));
  assert.equal(await candidatesIncludeUser, false, 'user excluded after first nudge');
});

test('S380 — CLI + HTTP trigger + jobRunner registration', async () => {
  // CLI script
  const cli = await fs.readFile('./src/jobs/send-first-booking-nudge.js', 'utf8');
  assert.match(cli, /sendFirstBookingNudges/);
  assert.match(cli, /runJob\('send-first-booking-nudge'/);

  // HTTP route in jobs router
  const route = await fs.readFile('./src/routes/jobs.js', 'utf8');
  assert.match(route, /\/send-first-booking-nudge/);

  // jobRunner interval registered
  const jr = await fs.readFile('./src/lib/jobRunner.js', 'utf8');
  assert.match(jr, /'send-first-booking-nudge'/);

  // package.json script
  const pkg = await fs.readFile('./package.json', 'utf8');
  assert.match(pkg, /"job:send-first-booking-nudge"/);
});

// ── S381 — Agen first-deal coaching ──────────────────────────

test('S381 — coaching returns null for agent with LUNAS bookings', async () => {
  const { getAgentFirstDealCoaching } = await import('../src/services/agentFirstDealCoaching.js');
  // Find an agent that HAS lunas bookings (seed has ahmad-w with LUNAS demo bookings)
  const exp = await db.agentProfile.findFirst({
    where: { bookings: { some: { status: 'LUNAS' } } },
    select: { id: true },
  });
  if (!exp) return; // skip if no seed has lunas
  const r = await getAgentFirstDealCoaching({ agentId: exp.id });
  assert.equal(r, null, 'experienced agent returns null');
});

test('S381 — coaching returns context for new agent with 0 LUNAS', async (t) => {
  const tag = makeTag('s381');
  // Create a new agent with no bookings
  const userTag = `${tag}-agen`;
  const user = await db.user.create({
    data: {
      email: `${userTag}@example.test`,
      passwordHash: await hashPassword('test12345'),
      role: 'AGEN', fullName: 'Agen Baru', phone: '+62812301',
      agent: { create: { slug: userTag, displayName: 'Agen Baru', whatsapp: '+62812301' } },
    },
    include: { agent: true },
  });
  t.after(async () => {
    await db.agentProfile.delete({ where: { id: user.agent.id } });
    await db.user.delete({ where: { id: user.id } });
  });
  const { getAgentFirstDealCoaching } = await import('../src/services/agentFirstDealCoaching.js');
  const r = await getAgentFirstDealCoaching({ agentId: user.agent.id });
  assert.ok(r);
  assert.equal(r.isNewAgent, true);
  assert.equal(r.activeBookingCount, 0);
  assert.equal(r.coldLeadCount, 0);
  assert.equal(r.agentSlug, userTag);
});

test('S381 — view renders coaching card when firstDealCoaching populated', async () => {
  const src = await fs.readFile('./views/agen-crm.ejs', 'utf8');
  assert.match(src, /First-deal coaching/);
  assert.match(src, /firstDealCoaching\.isNewAgent/);
  // 3 actionable tips
  assert.match(src, /Bagikan marketing kit/);
  assert.match(src, /Follow-up COLD leads/);
  assert.match(src, /lingkaran terdekat/);
});
