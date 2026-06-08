// Stage 120 — partner audit log API (HTTP integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { db, makeTag, tempUser, tempJemaah, tempPaket, tempBooking, fakeReq } from './_helpers.js';
import { createApp } from '../src/app.js';
import { createApiKey } from '../src/services/apiKeys.js';
import { updateBookingNotes } from '../src/services/bookingAdmin.js';

function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}
function close(srv) { return new Promise((r) => srv.close(r)); }

function req(srv, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = srv.address();
    const r = http.request({
      hostname: '127.0.0.1', port: addr.port, method, path, headers,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('/api/v1/audit: 401 without token', async (t) => {
  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/audit?entity=Booking&entityId=x');
    assert.equal(res.status, 401);
  } finally { await close(srv); }
});

test('/api/v1/audit: 403 when key lacks read:audit scope', async (t) => {
  const tag = makeTag('au-403');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: { id: u.id, email: u.email },
    name: tag, scopes: ['read:bookings'], // not read:audit
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/audit?entity=Booking&entityId=x',
      { Authorization: 'Bearer ' + k.token });
    assert.equal(res.status, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'INSUFFICIENT_SCOPE');
  } finally { await close(srv); }
});

test('/api/v1/audit: 400 when entity or entityId missing', async (t) => {
  const tag = makeTag('au-400');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: { id: u.id, email: u.email },
    name: tag, scopes: ['read:audit'],
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/audit',
      { Authorization: 'Bearer ' + k.token });
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'BAD_PARAMS');
  } finally { await close(srv); }
});

test('/api/v1/audit: returns scoped audit rows newest-first', async (t) => {
  const tag = makeTag('au-rows');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: { id: u.id, email: u.email },
    name: tag, scopes: ['read:audit'],
  });
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });
  // Generate a few audit rows on the booking
  await updateBookingNotes({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'OWNER' },
    bookingId: booking.id,
    notes: 'first note',
  });
  await updateBookingNotes({
    req: fakeReq,
    actor: { id: u.id, email: u.email, role: 'OWNER' },
    bookingId: booking.id,
    notes: 'second note',
  });
  t.after(async () => {
    await db.apiKey.deleteMany({ where: { id: k.id } });
    await db.auditLog.deleteMany({ where: { entity: 'Booking', entityId: booking.id } });
  });

  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', `/api/v1/audit?entity=Booking&entityId=${booking.id}`,
      { Authorization: 'Bearer ' + k.token });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 2);
    // newest first
    for (let i = 1; i < body.data.length; i++) {
      const prev = new Date(body.data[i - 1].createdAt).getTime();
      const cur = new Date(body.data[i].createdAt).getTime();
      assert.ok(prev >= cur, `row ${i - 1} should be >= row ${i}`);
    }
    // shape
    const row = body.data[0];
    assert.ok('action' in row);
    assert.ok('actorEmail' in row);
    assert.ok('after' in row);
    assert.ok('createdAt' in row);
    // filters echoed
    assert.equal(body.filters.entity, 'Booking');
    assert.equal(body.filters.entityId, booking.id);
  } finally { await close(srv); }
});

test('/api/v1/audit: pagination caps limit at 100', async (t) => {
  const tag = makeTag('au-pag');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: { id: u.id, email: u.email },
    name: tag, scopes: ['read:audit'],
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/audit?entity=Booking&entityId=none&limit=9999',
      { Authorization: 'Bearer ' + k.token });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.pagination.limit, 100);
  } finally { await close(srv); }
});
