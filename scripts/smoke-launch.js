// Pre-launch deployment smoke runner.
//
// Verifies a running instance — does NOT touch the DB directly. Run after
// every deploy (staging + prod) before announcing the rollout is healthy.
//
// Usage:
//   node scripts/smoke-launch.js --base https://staging.religio.pro
//   BASE_URL=https://religio.pro node scripts/smoke-launch.js
//
// Optional authenticated probe — when both vars are set, the script performs
// a form login and verifies the destination renders:
//   SMOKE_USER=ops@example.com SMOKE_PASS=... node scripts/smoke-launch.js
//
// Exit code is non-zero on any failed check.

const args = process.argv.slice(2);
const baseArgIdx = args.indexOf('--base');
const BASE_URL = (baseArgIdx >= 0 ? args[baseArgIdx + 1] : process.env.BASE_URL)
  || 'http://localhost:3000';

const SMOKE_USER = process.env.SMOKE_USER || '';
const SMOKE_PASS = process.env.SMOKE_PASS || '';
const SMOKE_PAKET_SLUG = process.env.SMOKE_PAKET_SLUG || '';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) {
  pass += 1;
  console.log(`  ok    ${name}`);
}
function bad(name, detail) {
  fail += 1;
  failures.push({ name, detail });
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function parseSetCookies(res) {
  // Node fetch exposes Set-Cookie via getSetCookie() on the headers object.
  const arr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.raw?.()['set-cookie'] || []);
  const jar = {};
  for (const line of arr) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    bad(name, err.message);
  }
}

async function main() {
  console.log(`\n→ Smoke run against ${BASE_URL}\n`);

  // 1. /api/health — must return JSON with a status field
  await check('GET /api/health returns valid JSON', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.status) throw new Error('response missing `status` field');
    if (body.status !== 'ok' && body.status !== 'degraded') {
      throw new Error(`unexpected status: ${body.status}`);
    }
    ok(`GET /api/health → ${body.status}`);
  });

  // 2. /login renders + mints CSRF cookie
  let csrfToken = null;
  let cookieJar = {};
  await check('GET /login renders + mints CSRF cookie', async () => {
    const res = await fetch(`${BASE_URL}/login`, { redirect: 'manual' });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    cookieJar = parseSetCookies(res);
    csrfToken = cookieJar.rp_csrf;
    if (!csrfToken) throw new Error('no rp_csrf cookie in Set-Cookie');
    ok('GET /login + rp_csrf cookie');
  });

  // 3. Sensitive-path block — /.env must NOT be served
  await check('GET /.env is blocked', async () => {
    const res = await fetch(`${BASE_URL}/.env`);
    if (res.status === 200) throw new Error('.env served — sensitive-path block disabled!');
    ok(`GET /.env → ${res.status} (blocked)`);
  });

  // 4. Sensitive-path block — /src/server.js
  await check('GET /src/server.js is blocked', async () => {
    const res = await fetch(`${BASE_URL}/src/server.js`);
    if (res.status === 200) throw new Error('src/ served — sensitive-path block disabled!');
    ok(`GET /src/server.js → ${res.status} (blocked)`);
  });

  // 5. Bogus-credentials login returns 401 (sanity that the auth layer is alive)
  await check('POST /login with bogus creds returns 401', async () => {
    const body = new URLSearchParams({
      email: 'definitely-not-a-user@nowhere.invalid',
      password: 'wrongpassword',
      _csrf: csrfToken || '',
    });
    const res = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader(cookieJar),
      },
      body,
      redirect: 'manual',
    });
    // Web login re-renders /login with an error on bad creds (200 OK with form body),
    // OR returns 401 — accept either as "auth layer alive, did not let us in".
    if (res.status === 200) {
      const html = await res.text();
      if (!/Email atau password salah|salah/i.test(html)) {
        throw new Error('bogus login returned 200 but no error message — auth bypass?');
      }
      ok('POST /login (bogus) → 200 + error message');
      return;
    }
    if (res.status !== 401 && res.status !== 302) {
      throw new Error(`expected 401/302, got ${res.status}`);
    }
    ok(`POST /login (bogus) → ${res.status}`);
  });

  // 6. Public paket landing — only if a slug is provided
  if (SMOKE_PAKET_SLUG) {
    await check(`GET /p/${SMOKE_PAKET_SLUG} renders`, async () => {
      const res = await fetch(`${BASE_URL}/p/${SMOKE_PAKET_SLUG}`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      if (!/<html/i.test(html)) throw new Error('not an HTML response');
      ok(`GET /p/${SMOKE_PAKET_SLUG} → 200`);
    });
  }

  // 7. Optional authenticated probe
  if (SMOKE_USER && SMOKE_PASS) {
    await check(`POST /login with SMOKE_USER (${SMOKE_USER})`, async () => {
      const body = new URLSearchParams({
        email: SMOKE_USER,
        password: SMOKE_PASS,
        _csrf: csrfToken || '',
      });
      const res = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookieHeader(cookieJar),
        },
        body,
        redirect: 'manual',
      });
      if (res.status !== 302) throw new Error(`expected 302 redirect, got ${res.status}`);
      const newCookies = parseSetCookies(res);
      Object.assign(cookieJar, newCookies);
      if (!cookieJar.rp_session) throw new Error('no rp_session cookie issued');
      ok(`POST /login → 302 → ${res.headers.get('location')}`);
    });

    await check('GET /api/auth/me with session', async () => {
      const res = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { Cookie: cookieHeader(cookieJar) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body.user?.email) throw new Error('no user in /api/auth/me');
      ok(`/api/auth/me → ${body.user.email} (${body.user.role})`);
    });
  }

  // Summary
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`pass: ${pass}    fail: ${fail}`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((err) => {
  console.error('Smoke runner crashed:', err);
  process.exit(2);
});
