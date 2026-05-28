// HTTP-level integration tests. Spins up the Express app once per file
// on a random port and makes real fetch() calls. Covers the gaps that
// service-layer tests can't reach: CSRF wire behavior, auth cookie flow,
// error-envelope shape, sensitive path block, webhook bypass.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { db } from './_helpers.js';

let server;
let baseUrl;

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Tiny cookie jar — captures Set-Cookie, echoes Cookie back. Stores name=value
// pairs; throws away attributes. Good enough for these tests.
function newJar() {
  const cookies = new Map();
  return {
    capture(res) {
      const setCookies = res.headers.getSetCookie?.() || [res.headers.get('set-cookie')].filter(Boolean);
      for (const sc of setCookies) {
        const [pair] = sc.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      return res;
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(name) { return cookies.get(name); },
  };
}

// Helper: GET → capture cookies → return both response + jar
async function getWithCookies(path, jar = newJar()) {
  const res = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    headers: jar.header() ? { Cookie: jar.header() } : {},
  });
  jar.capture(res);
  return { res, jar };
}

async function postForm(path, body, jar = newJar(), extraHeaders = {}) {
  const form = new URLSearchParams(body);
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.header(),
      ...extraHeaders,
    },
    body: form.toString(),
  });
  jar.capture(res);
  return { res, jar };
}

async function postJson(path, body, jar = newJar(), extraHeaders = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      Cookie: jar.header(),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  jar.capture(res);
  return { res, jar };
}

describe('GET /api/health', () => {
  test('returns 200 with status + db check + jobs', async () => {
    const { res } = await getWithCookies('/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(['ok', 'degraded'].includes(body.status));
    assert.equal(body.service, 'religio-pro');
    assert.equal(typeof body.uptime, 'number');
    assert.equal(typeof body.checks.db.ok, 'boolean');
    assert.ok(Array.isArray(body.checks.jobs) || body.checks.jobs === null
      || typeof body.checks.jobs === 'object', 'jobs is array OR null OR {error}');
  });

  test('GET mints rp_csrf cookie even on the health endpoint', async () => {
    const { jar } = await getWithCookies('/api/health');
    assert.ok(jar.get('rp_csrf'), 'rp_csrf set on first GET');
    assert.match(jar.get('rp_csrf'), /^[0-9a-f]{64}$/);
  });
});

describe('Sensitive path block', () => {
  test('blocks .env and other sensitive prefixes with 404', async () => {
    for (const path of ['/.env', '/.env.example', '/src/app.js', '/prisma/schema.prisma', '/private/docs/whatever', '/scripts/smoke-5pp-payment-gateway.js']) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 404, `${path} should be 404`);
    }
  });

  test('does NOT block public design assets', async () => {
    const res = await fetch(`${baseUrl}/shared/tokens.css`);
    assert.equal(res.status, 200);
    assert.ok(/font-display|cream/i.test(await res.text()));
  });
});

describe('CSRF wire behavior', () => {
  test('POST /api/payments/intent without CSRF token → 403', async () => {
    // No cookie at all → 403 (no cookie to compare against)
    const res = await fetch(`${baseUrl}/api/payments/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId: 'x', amount: 1 }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'CSRF_FAILED');
  });

  test('POST with cookie but no matching header/body field → 403', async () => {
    const { jar } = await getWithCookies('/login'); // mint csrf cookie
    const res = await fetch(`${baseUrl}/api/payments/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: jar.header(),
      },
      body: JSON.stringify({ bookingId: 'x', amount: 1 }),
    });
    assert.equal(res.status, 403);
  });

  test('POST with valid X-CSRF-Token header passes CSRF gate (failure comes from auth)', async () => {
    const { jar } = await getWithCookies('/login');
    const token = jar.get('rp_csrf');
    const res = await fetch(`${baseUrl}/api/payments/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: jar.header(),
        'X-CSRF-Token': token,
      },
      body: JSON.stringify({ bookingId: 'x', amount: 1 }),
    });
    // CSRF passed → request reaches the auth middleware which 401s (no session).
    // Either 401 (auth) or 302 (HTML redirect) — anything BUT 403 means CSRF accepted.
    assert.notEqual(res.status, 403, 'CSRF should have accepted; got 403');
  });

  test('POST with valid _csrf body field also passes (form-encoded form posts)', async () => {
    const { jar } = await getWithCookies('/login');
    const token = jar.get('rp_csrf');
    const { res } = await postForm('/login', {
      _csrf: token, email: 'nobody@example.test', password: 'wrong', next: '',
    }, jar);
    // CSRF passes; bad credentials → re-render login (200 or rate-limited 429)
    assert.notEqual(res.status, 403, 'body field CSRF should be accepted');
  });

  test('CSRF bypass list: Midtrans webhook does NOT require token', async () => {
    // No cookie at all → still gets past CSRF, then fails signature verify (401)
    const res = await fetch(`${baseUrl}/api/payments/midtrans/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: 'fake', status_code: '200', gross_amount: '1.00' /* no signature_key */ }),
    });
    // 401 BAD_SIGNATURE (webhook own auth) — NOT 403 CSRF_FAILED.
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'BAD_SIGNATURE');
  });
});

describe('Auth flow (cookie-based)', () => {
  // Reuse the seeded owner@religio.pro / owner12345 — verified to exist in dev.
  test('login with wrong password → 401 + generic error (no email-existence leak)', async () => {
    const { jar } = await getWithCookies('/login');
    const csrf = jar.get('rp_csrf');
    const { res } = await postForm('/login', {
      _csrf: csrf,
      email: 'definitely-not-a-user@example.test',
      password: 'whatever',
      next: '',
    }, jar);
    // Login HTML form re-renders with error message — 401 (auth failure).
    // The same status is returned whether the email exists or not — no leak.
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.ok(/Email atau password salah/.test(html));
  });

  test('login with right password sets rp_session + redirects by role', async (t) => {
    const ownerEmail = 'owner@religio.pro';
    const ownerExists = await db.user.findUnique({ where: { email: ownerEmail } });
    if (!ownerExists) {
      // Skip if seed hasn't been run
      t.skip('owner@religio.pro not in DB — run `npm run db:seed`');
      return;
    }
    const { jar } = await getWithCookies('/login');
    const csrf = jar.get('rp_csrf');
    const { res } = await postForm('/login', {
      _csrf: csrf, email: ownerEmail, password: 'owner12345', next: '',
    }, jar);
    // OWNER redirects to /admin
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin');
    assert.ok(jar.get('rp_session'), 'session cookie set');

    // GET /api/auth/me with the cookie → JSON user object
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: jar.header() },
    });
    assert.equal(meRes.status, 200);
    const me = await meRes.json();
    assert.equal(me.user.email, ownerEmail);
    assert.equal(me.user.role, 'OWNER');
  });

  test('protected HTML route without session → 302 to /login?next=', async () => {
    const res = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const loc = res.headers.get('location');
    assert.ok(loc.startsWith('/login'));
    assert.match(loc, /next=/);
  });

  test('protected JSON route without session → 401 with JSON envelope', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, { redirect: 'manual' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(typeof body.error.code, 'string');
    assert.match(body.error.message || '', /login|sesi|auth/i);
  });
});

describe('Error envelope shape', () => {
  test('/api/* 404 returns JSON envelope', async () => {
    const res = await fetch(`${baseUrl}/api/no-such-endpoint-xxx`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /json/);
    const body = await res.json();
    assert.ok(body.error);
    assert.equal(typeof body.error.code, 'string');
  });

  test('HTML 404 returns text/plain "Not found" (fast path, no view render)', async () => {
    const res = await fetch(`${baseUrl}/this-page-does-not-exist`);
    assert.equal(res.status, 404);
    const ct = res.headers.get('content-type') || '';
    // notFoundHandler deliberately returns a fast text/plain for unknown HTML
    // routes (bots, typos) — avoids EJS render cost. NOT JSON either.
    assert.match(ct, /text\/plain/i);
    assert.ok(!ct.includes('application/json'));
  });
});
