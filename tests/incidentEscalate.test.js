import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempMuthawwif, tempUser } from './_helpers.js';
import { escalateStaleIncidents } from '../src/services/incidentEscalate.js';

async function makeIncident({ crewId, createdAt, status = 'OPEN', escalatedAt = null }) {
  return db.incident.create({
    data: {
      type: 'SOS',
      message: 'test incident',
      status,
      createdById: crewId,
      createdAt,
      escalatedAt,
    },
  });
}

test('escalateStaleIncidents: skips fresh OPEN incidents below threshold', async (t) => {
  const tag = makeTag('esc-fresh');
  const crew = await tempMuthawwif(t, tag);
  await tempUser(t, `${tag}-o`, { role: 'OWNER' });

  const fresh = await makeIncident({
    crewId: crew.id,
    createdAt: new Date(Date.now() - 5 * 60_000), // 5 min old
  });
  t.after(() => db.incident.deleteMany({ where: { id: fresh.id } }));

  // Use a 60-min threshold (default)
  const r = await escalateStaleIncidents();
  assert.equal(r.candidates.includes(fresh.id), false, 'fresh incident should NOT be escalated');
});

test('escalateStaleIncidents: escalates stale OPEN and stamps escalatedAt', async (t) => {
  const tag = makeTag('esc-stale');
  const crew = await tempMuthawwif(t, tag);
  await tempUser(t, `${tag}-o`, { role: 'OWNER' });

  const stale = await makeIncident({
    crewId: crew.id,
    createdAt: new Date(Date.now() - 90 * 60_000), // 90 min old
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Incident', relatedEntityId: stale.id } });
    await db.incident.deleteMany({ where: { id: stale.id } });
  });

  const r = await escalateStaleIncidents();
  assert.ok(r.candidates.includes(stale.id), 'stale incident should be escalated');
  assert.ok(r.escalated >= 1);

  const after = await db.incident.findUnique({ where: { id: stale.id }, select: { escalatedAt: true } });
  assert.ok(after.escalatedAt instanceof Date, 'escalatedAt should be stamped');
});

test('escalateStaleIncidents: idempotent — already-escalated rows skipped on next run', async (t) => {
  const tag = makeTag('esc-idem');
  const crew = await tempMuthawwif(t, tag);
  await tempUser(t, `${tag}-o`, { role: 'OWNER' });

  const stale = await makeIncident({
    crewId: crew.id,
    createdAt: new Date(Date.now() - 90 * 60_000),
    escalatedAt: new Date(Date.now() - 30 * 60_000), // already escalated 30min ago
  });
  t.after(() => db.incident.deleteMany({ where: { id: stale.id } }));

  const r = await escalateStaleIncidents();
  assert.equal(r.candidates.includes(stale.id), false, 'already-escalated incident must NOT re-escalate');
});

test('escalateStaleIncidents: skips ACKED/RESOLVED incidents even if old', async (t) => {
  const tag = makeTag('esc-acked');
  const crew = await tempMuthawwif(t, tag);
  await tempUser(t, `${tag}-o`, { role: 'OWNER' });

  const acked = await makeIncident({
    crewId: crew.id,
    createdAt: new Date(Date.now() - 120 * 60_000),
    status: 'ACKED',
  });
  t.after(() => db.incident.deleteMany({ where: { id: acked.id } }));

  const r = await escalateStaleIncidents();
  assert.equal(r.candidates.includes(acked.id), false, 'ACKED incidents must NOT be escalated');
});

test('escalateStaleIncidents: fans EMAIL to OWNER only (not SUPERADMIN/MANAJER_OPS)', async (t) => {
  const tag = makeTag('esc-fan');
  const crew = await tempMuthawwif(t, tag);
  const owner = await tempUser(t, `${tag}-own`, { role: 'OWNER' });
  await tempUser(t, `${tag}-sup`, { role: 'SUPERADMIN' });
  await tempUser(t, `${tag}-mgr`, { role: 'MANAJER_OPS' });

  const stale = await makeIncident({
    crewId: crew.id,
    createdAt: new Date(Date.now() - 75 * 60_000),
  });
  t.after(async () => {
    await db.notification.deleteMany({ where: { relatedEntity: 'Incident', relatedEntityId: stale.id } });
    await db.incident.deleteMany({ where: { id: stale.id } });
  });

  await escalateStaleIncidents();

  const notifs = await db.notification.findMany({
    where: { relatedEntity: 'Incident', relatedEntityId: stale.id, type: 'INCIDENT_ESCALATED' },
    select: { recipientEmail: true, channel: true },
  });
  // OWNER tier only — should include the seeded owner@religio.pro plus our tempUser owner.
  // Critical assertion: NO superadmin/manajer_ops email should appear.
  const recipients = notifs.map((n) => n.recipientEmail);
  assert.ok(recipients.includes(owner.email), 'OWNER tempUser should receive escalation');
  assert.ok(!recipients.some((e) => e?.includes(`${tag}-sup`)), 'SUPERADMIN must NOT receive');
  assert.ok(!recipients.some((e) => e?.includes(`${tag}-mgr`)), 'MANAJER_OPS must NOT receive');
  assert.ok(notifs.every((n) => n.channel === 'EMAIL'), 'all escalation rows are EMAIL channel');
});
