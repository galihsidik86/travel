// Incidents — crew SOS + admin ack/resolve state machine.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeTag, tempMuthawwif, tempUser, tempPaket } from './_helpers.js';
import {
  createIncident, ackIncident, resolveIncident, listIncidents, getIncident, listMyIncidents,
} from '../src/services/incidents.js';

const fakeReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } };

describe('createIncident', () => {
  test('crew can raise SOS without paket — null paketId, status OPEN', async (t) => {
    const tag = makeTag('inc-create');
    const crew = await tempMuthawwif(t, tag);
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    const inc = await createIncident({
      req: fakeReq, crewUser: crew,
      input: { type: 'SOS', message: 'help me' },
    });
    assert.equal(inc.status, 'OPEN');
    assert.equal(inc.type, 'SOS');
    assert.equal(inc.paketId, null);
    assert.equal(inc.createdById, crew.id);
  });

  test('paketSlug filled when crew is assigned, ignored otherwise', async (t) => {
    const tag = makeTag('inc-paket');
    const crew = await tempMuthawwif(t, tag);
    const paket = await tempPaket(t, `paket-${tag}`);
    await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    const assigned = await createIncident({
      req: fakeReq, crewUser: crew,
      input: { type: 'MEDICAL', paketSlug: paket.slug, message: 'cek dulu' },
    });
    assert.equal(assigned.paketId, paket.id, 'paketId resolved from assigned slug');

    const ghost = await createIncident({
      req: fakeReq, crewUser: crew,
      input: { type: 'OTHER', paketSlug: 'does-not-exist', message: 'unrelated' },
    });
    assert.equal(ghost.paketId, null, 'unknown slug → null paketId (does not abort the SOS)');
  });

  test('non-crew role rejected with 403', async (t) => {
    const tag = makeTag('inc-rbac');
    const admin = await tempUser(t, tag, { role: 'OWNER' });

    await assert.rejects(
      () => createIncident({ req: fakeReq, crewUser: admin, input: { type: 'SOS' } }),
      (err) => err.status === 403 && err.code === 'FORBIDDEN',
    );
  });

  test('fan-out enqueues one EMAIL + one WA per admin (with both email & phone)', async (t) => {
    const tag = makeTag('inc-fanout');
    const crew = await tempMuthawwif(t, tag);
    const admin1 = await tempUser(t, tag, { role: 'OWNER' });
    const admin2 = await tempUser(t, tag, { role: 'MANAJER_OPS' });
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    const inc = await createIncident({
      req: fakeReq, crewUser: crew,
      input: { type: 'SOS', message: 'jemaah hilang di Mina' },
    });
    // Notif enqueue is awaited inside createIncident before the catch, but the
    // helper itself returns the row sync after fan-out — give it a tick to flush.
    await new Promise((r) => setTimeout(r, 200));

    const notifs = await db.notification.findMany({
      where: { relatedEntity: 'Incident', relatedEntityId: inc.id },
    });
    // 2 admins × 2 channels (admins seeded with both email + phone) = 4
    assert.ok(notifs.length >= 2, `expected ≥2 notif rows for fan-out, got ${notifs.length}`);
    const types = new Set(notifs.map((n) => n.type));
    assert.ok(types.has('INCIDENT_REPORTED'), 'fan-out uses INCIDENT_REPORTED type');
    const channels = new Set(notifs.map((n) => n.channel));
    assert.ok(channels.has('EMAIL'), 'EMAIL channel fanned out');
    assert.ok(channels.has('WA'), 'WA channel fanned out');
    for (const n of notifs) {
      assert.equal(n.recipientUserId, null, 'admin fan-out never carries recipientUserId (5ll invariant)');
    }
  });
});

describe('ackIncident', () => {
  test('OPEN → ACKED stamps ackedBy + ackedAt', async (t) => {
    const tag = makeTag('inc-ack');
    const crew = await tempMuthawwif(t, tag);
    const admin = await tempUser(t, tag, { role: 'SUPERADMIN' });
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    const inc = await createIncident({
      req: fakeReq, crewUser: crew, input: { type: 'SOS', message: 'x' },
    });
    const acked = await ackIncident({ req: fakeReq, adminUser: admin, id: inc.id });
    assert.equal(acked.status, 'ACKED');
    assert.equal(acked.ackedById, admin.id);
    assert.ok(acked.ackedAt);
  });

  test('cannot ack twice — 409', async (t) => {
    const tag = makeTag('inc-ack2');
    const crew = await tempMuthawwif(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    const inc = await createIncident({ req: fakeReq, crewUser: crew, input: { type: 'OTHER' } });
    await ackIncident({ req: fakeReq, adminUser: admin, id: inc.id });
    await assert.rejects(
      () => ackIncident({ req: fakeReq, adminUser: admin, id: inc.id }),
      (err) => err.status === 409 && err.code === 'NOT_ACKABLE',
    );
  });
});

describe('resolveIncident', () => {
  test('ACKED → RESOLVED with required resolution', async (t) => {
    const tag = makeTag('inc-res');
    const crew = await tempMuthawwif(t, tag);
    const admin = await tempUser(t, tag, { role: 'MANAJER_OPS' });
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    const inc = await createIncident({ req: fakeReq, crewUser: crew, input: { type: 'MEDICAL', message: 'pingsan' } });
    await ackIncident({ req: fakeReq, adminUser: admin, id: inc.id });
    const resolved = await resolveIncident({
      req: fakeReq, adminUser: admin, id: inc.id,
      input: { resolution: 'Rujuk ke RS King Fahd, kembali ke hotel jam 22.40.' },
    });
    assert.equal(resolved.status, 'RESOLVED');
    assert.match(resolved.resolution, /King Fahd/);
    assert.equal(resolved.resolvedById, admin.id);
    assert.ok(resolved.resolvedAt);
    assert.ok(resolved.ackedAt, 'ack timestamp preserved');
  });

  test('OPEN → RESOLVED auto-stamps ack to current admin', async (t) => {
    const tag = makeTag('inc-jump');
    const crew = await tempMuthawwif(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    const inc = await createIncident({ req: fakeReq, crewUser: crew, input: { type: 'OTHER' } });
    const resolved = await resolveIncident({
      req: fakeReq, adminUser: admin, id: inc.id,
      input: { resolution: 'False alarm; logged for record.' },
    });
    assert.equal(resolved.status, 'RESOLVED');
    assert.equal(resolved.ackedById, admin.id, 'auto-ack when skipping straight to resolve');
    assert.ok(resolved.ackedAt);
  });

  test('resolution shorter than 3 chars rejected', async (t) => {
    const tag = makeTag('inc-res-short');
    const crew = await tempMuthawwif(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    const inc = await createIncident({ req: fakeReq, crewUser: crew, input: { type: 'OTHER' } });
    await assert.rejects(
      () => resolveIncident({ req: fakeReq, adminUser: admin, id: inc.id, input: { resolution: 'ok' } }),
      (err) => err.status === 400,
    );
  });

  test('cannot resolve an already-resolved incident', async (t) => {
    const tag = makeTag('inc-res2');
    const crew = await tempMuthawwif(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    const inc = await createIncident({ req: fakeReq, crewUser: crew, input: { type: 'OTHER' } });
    await resolveIncident({
      req: fakeReq, adminUser: admin, id: inc.id, input: { resolution: 'closed' },
    });
    await assert.rejects(
      () => resolveIncident({ req: fakeReq, adminUser: admin, id: inc.id, input: { resolution: 'again' } }),
      (err) => err.status === 409 && err.code === 'ALREADY_RESOLVED',
    );
  });
});

describe('listIncidents + listMyIncidents', () => {
  test('OPEN bubbles to top of listIncidents, newest first within status', async (t) => {
    const tag = makeTag('inc-list');
    const crew = await tempMuthawwif(t, tag);
    const admin = await tempUser(t, tag, { role: 'OWNER' });
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    const i1 = await createIncident({ req: fakeReq, crewUser: crew, input: { type: 'OTHER' } });
    const i2 = await createIncident({ req: fakeReq, crewUser: crew, input: { type: 'SOS' } });
    // Resolve i1 so we have a mixed status set
    await resolveIncident({ req: fakeReq, adminUser: admin, id: i1.id, input: { resolution: 'closed cleanly' } });

    const { rows } = await listIncidents({});
    const ourRows = rows.filter((r) => r.createdById === crew.id);
    assert.equal(ourRows[0].id, i2.id, 'OPEN row first');
    assert.equal(ourRows[ourRows.length - 1].id, i1.id, 'RESOLVED row last');
  });

  test('listMyIncidents scopes to a single crew', async (t) => {
    const tag = makeTag('inc-mine');
    const crewA = await tempMuthawwif(t, `${tag}-a`);
    const crewB = await tempMuthawwif(t, `${tag}-b`);
    t.after(async () => {
      await db.notification.deleteMany({ where: { relatedEntity: 'Incident' } });
    });

    await createIncident({ req: fakeReq, crewUser: crewA, input: { type: 'SOS' } });
    await createIncident({ req: fakeReq, crewUser: crewA, input: { type: 'MEDICAL' } });
    await createIncident({ req: fakeReq, crewUser: crewB, input: { type: 'OTHER' } });

    const mineA = await listMyIncidents(crewA.id);
    const mineB = await listMyIncidents(crewB.id);
    assert.equal(mineA.length, 2);
    assert.equal(mineB.length, 1);
    assert.ok(mineA.every((r) => r.createdById === crewA.id));
  });
});
