// Stage 114 — partner-facing read API (HTTP integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { db, makeTag, tempUser, tempJemaah, tempPaket, tempBooking, fakeReq } from './_helpers.js';
import { createApp } from '../src/app.js';
import { createApiKey } from '../src/services/apiKeys.js';

function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}
function close(srv) { return new Promise((r) => srv.close(r)); }

function req(srv, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const addr = srv.address();
    const r = http.request({
      hostname: '127.0.0.1', port: addr.port, method, path,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('/api/v1/bookings: 401 without Bearer token', async (t) => {
  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/bookings');
    assert.equal(res.status, 401);
  } finally { await close(srv); }
});

test('/api/v1/bookings: 403 when token lacks read:bookings scope', async (t) => {
  const tag = makeTag('av-403');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({ req: fakeReq, actor: { id: u.id, email: u.email }, name: tag, scopes: ['read:paket'] });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/bookings', { Authorization: 'Bearer ' + k.token });
    assert.equal(res.status, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'INSUFFICIENT_SCOPE');
  } finally { await close(srv); }
});

test('/api/v1/bookings: returns paginated JSON with full shape', async (t) => {
  const tag = makeTag('av-list');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({ req: fakeReq, actor: { id: u.id, email: u.email }, name: tag, scopes: ['read:bookings'] });
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/bookings?limit=10', { Authorization: 'Bearer ' + k.token });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.pagination);
    assert.equal(body.pagination.limit, 10);
    // Our booking should be in the data
    const mine = body.data.find((b) => b.id === booking.id);
    assert.ok(mine, 'created booking present in result');
    assert.equal(mine.bookingNo, booking.bookingNo);
    assert.equal(mine.jemaah.fullName, j.jemaah.fullName);
    assert.equal(mine.paket.slug, paket.slug);
    assert.equal(typeof mine.totalAmountIdr, 'number');
  } finally { await close(srv); }
});

test('/api/v1/bookings/:id: returns single booking with payments[]', async (t) => {
  const tag = makeTag('av-one');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({ req: fakeReq, actor: { id: u.id, email: u.email }, name: tag, scopes: ['read:bookings'] });
  const j = await tempJemaah(t, tag);
  const paket = await tempPaket(t, tag);
  const booking = await tempBooking({ paket, jemaahProfileId: j.jemaah.id });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', `/api/v1/bookings/${booking.id}`, { Authorization: 'Bearer ' + k.token });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.id, booking.id);
    assert.ok(Array.isArray(body.data.payments));
  } finally { await close(srv); }
});

test('/api/v1/bookings/:id: 404 for unknown id', async (t) => {
  const tag = makeTag('av-404');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({ req: fakeReq, actor: { id: u.id, email: u.email }, name: tag, scopes: ['read:bookings'] });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/bookings/nonexistent', { Authorization: 'Bearer ' + k.token });
    assert.equal(res.status, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'BOOKING_NOT_FOUND');
  } finally { await close(srv); }
});

test('/api/v1/paket: lists ACTIVE paket; requires read:paket scope', async (t) => {
  const tag = makeTag('av-paket');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({ req: fakeReq, actor: { id: u.id, email: u.email }, name: tag, scopes: ['read:paket'] });
  const paket = await tempPaket(t, tag);
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/paket', { Authorization: 'Bearer ' + k.token });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.data));
    const mine = body.data.find((p) => p.id === paket.id);
    assert.ok(mine);
    assert.equal(mine.slug, paket.slug);
  } finally { await close(srv); }
});
