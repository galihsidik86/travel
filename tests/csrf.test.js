// CSRF middleware tests (double-submit cookie). Pure unit — exercises the
// middleware directly with fake req/res objects, no Express, no DB.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { csrfProtection, CSRF_COOKIE, CSRF_HEADER } from '../src/middleware/csrf.js';

// Minimal req/res factory — supports just what the middleware uses.
function fakeReq({ method = 'GET', path = '/', cookies = {}, headers = {}, body = {} } = {}) {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method, path, cookies, body,
    get(name) { return lowerHeaders[name.toLowerCase()]; },
  };
}
function fakeRes() {
  const state = { statusCode: 200, cookies: [], body: null, type: null, locals: {}, sent: false };
  const res = {
    locals: state.locals,
    status(c) { state.statusCode = c; return this; },
    cookie(name, val, opts) { state.cookies.push({ name, val, opts }); return this; },
    json(o) { state.body = o; state.sent = true; return this; },
    type(t) { state.type = t; return this; },
    send(b) { state.body = b; state.sent = true; return this; },
    _state: state,
  };
  return res;
}
// Resolves on EITHER next() called OR res.json/send (responded). The
// middleware short-circuits with res.json/send on the 403 path and doesn't
// call next() — without this, the test would hang.
function runMw(mw, req, res) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => { if (done) return; done = true; err ? reject(err) : resolve(); };
    // Wrap send/json to resolve when called
    const origSend = res.send.bind(res);
    const origJson = res.json.bind(res);
    res.send = (b) => { const r = origSend(b); finish(); return r; };
    res.json = (o) => { const r = origJson(o); finish(); return r; };
    try { mw(req, res, (err) => finish(err)); } catch (e) { finish(e); }
  });
}

describe('csrfProtection — token minting + read-only requests', () => {
  test('GET without cookie mints a token + sets cookie + exposes locals.csrfToken', async () => {
    const mw = csrfProtection();
    const req = fakeReq();
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.cookies.length, 1, 'cookie set');
    const c = res._state.cookies[0];
    assert.equal(c.name, CSRF_COOKIE);
    assert.match(c.val, /^[0-9a-f]{64}$/, 'token is 32-byte hex');
    assert.equal(c.opts.httpOnly, false, 'cookie MUST be readable by client JS');
    assert.equal(c.opts.sameSite, 'lax');
    assert.equal(res.locals.csrfToken, c.val, 'exposed via res.locals');
    assert.equal(res._state.statusCode, 200, 'GET passes through');
  });

  test('GET with existing cookie reuses it (no rotation)', async () => {
    const existing = 'a'.repeat(64);
    const mw = csrfProtection();
    const req = fakeReq({ cookies: { [CSRF_COOKIE]: existing } });
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.cookies.length, 0, 'no new cookie when one exists');
    assert.equal(res.locals.csrfToken, existing);
  });

  test('HEAD + OPTIONS are read-only and pass through', async () => {
    for (const method of ['HEAD', 'OPTIONS']) {
      const mw = csrfProtection();
      const req = fakeReq({ method });
      const res = fakeRes();
      await runMw(mw, req, res);
      assert.equal(res._state.statusCode, 200, `${method} passes`);
    }
  });
});

describe('csrfProtection — state-changing requests', () => {
  test('POST without cookie + no token → 403 (mints fresh cookie too)', async () => {
    const mw = csrfProtection();
    const req = fakeReq({ method: 'POST', path: '/admin/users' });
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.statusCode, 403);
    assert.equal(res._state.cookies.length, 1, 'cookie still minted on rejected POST');
  });

  test('POST with cookie + matching header → passes', async () => {
    const tok = 'b'.repeat(64);
    const mw = csrfProtection();
    const req = fakeReq({
      method: 'POST', path: '/admin/users',
      cookies: { [CSRF_COOKIE]: tok },
      headers: { [CSRF_HEADER]: tok },
    });
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.statusCode, 200, 'header match passes');
  });

  test('POST with cookie + matching body field → passes', async () => {
    const tok = 'c'.repeat(64);
    const mw = csrfProtection();
    const req = fakeReq({
      method: 'POST', path: '/admin/users',
      cookies: { [CSRF_COOKIE]: tok },
      body: { _csrf: tok, other: 'data' },
    });
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.statusCode, 200, 'body _csrf match passes');
  });

  test('POST with cookie + mismatched header → 403', async () => {
    const mw = csrfProtection();
    const req = fakeReq({
      method: 'POST', path: '/admin/users',
      cookies: { [CSRF_COOKIE]: 'a'.repeat(64) },
      headers: { [CSRF_HEADER]: 'b'.repeat(64) },
    });
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.statusCode, 403);
  });

  test('POST with cookie + header of wrong length → 403 (no throw)', async () => {
    const mw = csrfProtection();
    const req = fakeReq({
      method: 'POST', path: '/admin/users',
      cookies: { [CSRF_COOKIE]: 'a'.repeat(64) },
      headers: { [CSRF_HEADER]: 'short' },
    });
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.statusCode, 403);
  });

  test('API rejection returns JSON error envelope', async () => {
    const mw = csrfProtection();
    const req = fakeReq({ method: 'POST', path: '/api/payments' });
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.body.error.code, 'CSRF_FAILED');
  });

  test('HTML rejection returns plain text', async () => {
    const mw = csrfProtection();
    const req = fakeReq({ method: 'POST', path: '/admin/users' });
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.type, 'text/plain');
    assert.match(res._state.body, /CSRF/);
  });
});

describe('csrfProtection — bypass paths (webhook + health)', () => {
  test('Midtrans webhook POST bypasses (signed by upstream)', async () => {
    const mw = csrfProtection();
    const req = fakeReq({ method: 'POST', path: '/api/payments/midtrans/webhook' });
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.statusCode, 200, 'webhook bypasses CSRF (upstream signature is the auth)');
  });

  test('/api/health bypass — GET already exempt, POST also (no state change)', async () => {
    const mw = csrfProtection();
    const req = fakeReq({ method: 'GET', path: '/api/health' });
    const res = fakeRes();
    await runMw(mw, req, res);
    assert.equal(res._state.statusCode, 200);
  });
});
