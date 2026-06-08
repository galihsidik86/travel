// Stage 127 — outbound webhook dispatches for the new event types
// (`booking.cancelled`, `booking.status_changed`, `booking.notes_updated`,
// `incident.created`, `incident.resolved`). Verifies the call sites in
// bookingAdmin / payment / incidents actually invoke `dispatchEvent` with
// the right event name + payload shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, tempPaket, tempJemaah, tempBooking, tempMuthawwif, fakeReq } from './_helpers.js';
import { createWebhook, EVENT_NAMES } from '../src/services/webhooks.js';
import { cancelBooking, updateBookingNotes } from '../src/services/bookingAdmin.js';
import { recordPayment } from '../src/services/payment.js';
import { createIncident, resolveIncident } from '../src/services/incidents.js';

function actor(u) { return { id: u.id, email: u.email, role: u.role || 'OWNER' }; }

// Capture every outbound HTTP call dispatchEvent emits. The webhook
// service uses global fetch under the hood — stubbing it gives us a
// per-test recorder without any partner endpoint.
function stubFetch(t) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    let parsedBody = null;
    try { parsedBody = JSON.parse(opts?.body || 'null'); } catch { /* ignore */ }
    calls.push({
      url,
      event: opts?.headers?.['X-Religio-Event'] || null,
      body: parsedBody,
    });
    return { status: 200, ok: true };
  };
  t.after(() => { global.fetch = original; });
  return calls;
}

test('EVENT_NAMES: includes the 4 new S127 events', () => {
  for (const ev of ['booking.status_changed', 'booking.notes_updated', 'incident.created', 'incident.resolved']) {
    assert.ok(EVENT_NAMES.includes(ev), `missing ${ev}`);
  }
});

test('cancelBooking: dispatches booking.cancelled + booking.status_changed', async (t) => {
  const tag = makeTag('whE-cancel');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/h',
    events: ['booking.cancelled', 'booking.status_changed'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const calls = stubFetch(t);
  await cancelBooking({ req: fakeReq, actor: actor(owner), bookingId: booking.id, reason: 'test cancel' });

  const events = calls.map((c) => c.event).sort();
  assert.deepEqual(events, ['booking.cancelled', 'booking.status_changed']);

  // Both payloads should reference the same booking + carry status transition.
  for (const c of calls) {
    assert.equal(c.body.payload.bookingId, booking.id);
    assert.equal(c.body.payload.status, 'CANCELLED');
    assert.equal(c.body.payload.previousStatus, 'PENDING');
    assert.equal(c.body.payload.reason, 'test cancel');
  }
});

test('updateBookingNotes: dispatches booking.notes_updated with preview', async (t) => {
  const tag = makeTag('whE-notes');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/notes',
    events: ['booking.notes_updated'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const calls = stubFetch(t);
  await updateBookingNotes({ req: fakeReq, actor: actor(owner), bookingId: booking.id, notes: 'jemaah minta kursi jendela' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'booking.notes_updated');
  assert.equal(calls[0].body.payload.bookingId, booking.id);
  assert.equal(calls[0].body.payload.notesPreview, 'jemaah minta kursi jendela');
  assert.equal(calls[0].body.payload.actorEmail, owner.email);
});

test('updateBookingNotes: no-op save → NO dispatch fires', async (t) => {
  const tag = makeTag('whE-notes-noop');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id });
  // Set initial notes
  await db.booking.update({ where: { id: booking.id }, data: { notes: 'sama' } });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/notes',
    events: ['booking.notes_updated'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const calls = stubFetch(t);
  // Same notes → no-op short-circuit in updateBookingNotes
  await updateBookingNotes({ req: fakeReq, actor: actor(owner), bookingId: booking.id, notes: 'sama' });
  assert.equal(calls.length, 0, 'no-op save must NOT fire webhook');
});

test('recordPayment: partial payment dispatches booking.status_changed (DP_PAID)', async (t) => {
  const tag = makeTag('whE-payment');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  const jem = await tempJemaah(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: jem.jemaah.id, totalAmount: '1000000' });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/pay',
    events: ['payment.received', 'booking.status_changed'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
  });

  const calls = stubFetch(t);
  // Partial: 300k of 1M → DP_PAID (not LUNAS)
  await recordPayment({
    req: fakeReq, actor: actor(owner),
    bookingId: booking.id, amount: 300_000, method: 'TRANSFER',
  });

  const events = calls.map((c) => c.event).sort();
  assert.ok(events.includes('payment.received'));
  assert.ok(events.includes('booking.status_changed'), 'partial → DP_PAID must fire status_changed');
  // booking.lunas should NOT fire on a partial
  assert.ok(!events.includes('booking.lunas'));

  const status = calls.find((c) => c.event === 'booking.status_changed');
  assert.equal(status.body.payload.previousStatus, 'PENDING');
  assert.equal(status.body.payload.status, 'DP_PAID');
});

test('createIncident: dispatches incident.created with crew context', async (t) => {
  const tag = makeTag('whE-inc-create');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  const crew = await tempMuthawwif(t, tag);
  // Assign crew to paket so the resolver attaches paketId
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/inc',
    events: ['incident.created'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
    await db.incident.deleteMany({ where: { createdById: crew.id } });
  });

  const calls = stubFetch(t);
  await createIncident({
    req: fakeReq, crewUser: crew,
    input: { type: 'MEDICAL', paketSlug: paket.slug, message: 'jemaah pingsan', locationLabel: 'Madinah' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'incident.created');
  const p = calls[0].body.payload;
  assert.equal(p.type, 'MEDICAL');
  assert.equal(p.paketSlug, paket.slug);
  assert.equal(p.crewEmail, crew.email);
  assert.equal(p.message, 'jemaah pingsan');
  assert.equal(p.locationLabel, 'Madinah');
  assert.ok(p.incidentId, 'incidentId present');
});

test('resolveIncident: dispatches incident.resolved with resolution text', async (t) => {
  const tag = makeTag('whE-inc-res');
  const owner = await tempUser(t, tag, { role: 'OWNER' });
  const paket = await tempPaket(t, tag);
  const crew = await tempMuthawwif(t, tag);
  await db.paketCrew.create({ data: { paketId: paket.id, userId: crew.id } });

  // Pre-create an incident, skip the create-webhook so we measure only resolve
  const incident = await db.incident.create({
    data: { type: 'OTHER', paketId: paket.id, createdById: crew.id, status: 'OPEN' },
  });

  const wh = await createWebhook({
    req: fakeReq, actor: actor(owner),
    url: 'https://test.example/inc-res',
    events: ['incident.resolved'],
  });
  t.after(async () => {
    await db.webhookDelivery.deleteMany({ where: { webhookId: wh.id } });
    await db.webhook.delete({ where: { id: wh.id } });
    await db.incident.deleteMany({ where: { id: incident.id } });
  });

  const calls = stubFetch(t);
  await resolveIncident({
    req: fakeReq, adminUser: owner, id: incident.id,
    input: { resolution: 'jemaah sudah ditangani' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'incident.resolved');
  const p = calls[0].body.payload;
  assert.equal(p.incidentId, incident.id);
  assert.equal(p.type, 'OTHER');
  assert.equal(p.resolution, 'jemaah sudah ditangani');
  assert.equal(p.resolvedByEmail, owner.email);
  assert.equal(p.previousStatus, 'OPEN');
});
