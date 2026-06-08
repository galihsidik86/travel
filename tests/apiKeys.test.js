import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import {
  createApiKey, updateApiKeyStatus, deleteApiKey,
  resolveBearerToken, requireApiScope, formatToken, KNOWN_SCOPES,
} from '../src/services/apiKeys.js';
import { HttpError } from '../src/middleware/error.js';

function actor(u) { return { id: u.id, email: u.email, role: 'OWNER' }; }

test('createApiKey: rejects empty name', async (t) => {
  const tag = makeTag('ak-name');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  await assert.rejects(
    () => createApiKey({ req: fakeReq, actor: actor(u), name: '', scopes: ['read:bookings'] }),
    (err) => err instanceof HttpError && err.code === 'BAD_NAME',
  );
});

test('createApiKey: rejects no scopes', async (t) => {
  const tag = makeTag('ak-noscope');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  await assert.rejects(
    () => createApiKey({ req: fakeReq, actor: actor(u), name: 'partner', scopes: [] }),
    (err) => err instanceof HttpError && err.code === 'NO_SCOPES',
  );
});

test('createApiKey: filters unknown scopes silently', async (t) => {
  const tag = makeTag('ak-filter');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u), name: 'p1',
    scopes: ['read:bookings', 'not:real'],
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));
  assert.deepEqual(k.scopes, ['read:bookings']);
});

test('createApiKey: returns plaintext token ONCE, hashed in DB', async (t) => {
  const tag = makeTag('ak-token');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u), name: 'p2', scopes: ['read:bookings'],
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  assert.match(k.token, /^rp_[A-Za-z0-9]+\.[0-9a-f]{64}$/, 'token shape rp_<id>.<hex>');

  // Stored hash is NOT the plaintext
  const row = await db.apiKey.findUnique({ where: { id: k.id } });
  const secret = k.token.split('.')[1];
  assert.notEqual(row.hashedKey, secret);
  assert.ok(row.hashedKey.startsWith('$2'), 'bcrypt prefix');
});

test('resolveBearerToken: returns row for valid token + stamps lastUsedAt', async (t) => {
  const tag = makeTag('ak-resolve');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u), name: 'p3', scopes: ['read:bookings'],
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  const resolved = await resolveBearerToken('Bearer ' + k.token);
  assert.ok(resolved);
  assert.equal(resolved.id, k.id);

  // lastUsedAt stamping is fire-and-forget; allow a tick for it to flush
  await new Promise((r) => setTimeout(r, 50));
  const after = await db.apiKey.findUnique({ where: { id: k.id }, select: { lastUsedAt: true } });
  assert.ok(after.lastUsedAt instanceof Date);
});

test('resolveBearerToken: null for bad shape / wrong secret / suspended / missing', async (t) => {
  const tag = makeTag('ak-bad');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u), name: 'p4', scopes: ['read:bookings'],
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  assert.equal(await resolveBearerToken(null), null);
  assert.equal(await resolveBearerToken('Bearer not-a-token'), null);
  assert.equal(await resolveBearerToken('NotBearer xxx'), null);
  // Wrong secret
  assert.equal(await resolveBearerToken('Bearer ' + formatToken(k.id, 'a'.repeat(64))), null);
  // Suspended
  await updateApiKeyStatus({ req: fakeReq, actor: actor(u), id: k.id, status: 'SUSPENDED' });
  assert.equal(await resolveBearerToken('Bearer ' + k.token), null, 'SUSPENDED → null');
});

test('requireApiScope: 401 on missing/invalid token, 403 on scope miss, next() on success', async (t) => {
  const tag = makeTag('ak-mw');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u), name: 'p5', scopes: ['read:bookings'],
  });
  t.after(() => db.apiKey.deleteMany({ where: { id: k.id } }));

  function makeReq(token) { return { headers: { authorization: token } }; }
  // Resolve a promise from json() so we don't hang when the middleware
  // refuses the request (which doesn't call next()).
  function makeRes() {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    return {
      done: p,
      status(s) { this._status = s; return this; },
      json(b) { this._body = b; resolve(); return this; },
    };
  }

  // Missing token → 401 (no next call; resolve via res.json)
  let res = makeRes();
  await requireApiScope('read:bookings')(makeReq(undefined), res, () => {});
  await res.done;
  assert.equal(res._status, 401);

  // Valid token but wrong scope → 403
  res = makeRes();
  await requireApiScope('read:notifs')(makeReq('Bearer ' + k.token), res, () => {});
  await res.done;
  assert.equal(res._status, 403);
  assert.equal(res._body.error.code, 'INSUFFICIENT_SCOPE');

  // Valid token + correct scope → next() called with apiKey on req
  const req = makeReq('Bearer ' + k.token);
  let called = false;
  await new Promise((done) => {
    requireApiScope('read:bookings')(req, { status: () => ({ json: () => {} }) }, () => {
      called = true; done();
    });
  });
  assert.equal(called, true);
  assert.equal(req.apiKey?.id, k.id);
});
