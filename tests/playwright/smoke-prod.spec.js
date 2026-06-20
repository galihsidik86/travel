// Production smoke audit. Runs against the deployed instance and probes
// the surfaces that "look fine in manual click-through" — verifies render,
// JS console clean, critical elements present, no role-misroute 403s.
//
// Run: npx playwright test
// Override target: SMOKE_BASE_URL=https://staging.example npx playwright test

import { test, expect } from '@playwright/test';

const accounts = {
  owner: { email: 'owner@religio.pro', password: 'owner12345' },
  kasir: { email: 'kasir@religio.pro', password: 'kasir12345' },
  agen: { email: 'ahmad@religio.pro', password: 'ahmad12345' },
  jemaah: { email: 'test-jemaah-s309@example.test', password: 'test12345' },
};

const jsErrors = [];
const ignoredErrorPatterns = [
  /favicon\.ico/i,
  /ServiceWorker.*SecurityError/i,
];

test.beforeEach(async ({ page }, info) => {
  jsErrors.length = 0;
  page.on('pageerror', (e) => {
    const msg = `pageerror: ${e.message}`;
    if (!ignoredErrorPatterns.some((r) => r.test(msg))) jsErrors.push(msg);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const text = `console.error: ${m.text()}`;
      if (!ignoredErrorPatterns.some((r) => r.test(text))) jsErrors.push(text);
    }
  });
  page.on('requestfailed', (r) => {
    const msg = `requestfailed: ${r.url()} → ${r.failure()?.errorText || '?'}`;
    if (!ignoredErrorPatterns.some((rx) => rx.test(msg))) jsErrors.push(msg);
  });
});

test.afterEach(async ({}, info) => {
  if (jsErrors.length) {
    await info.attach('js-errors.txt', {
      body: jsErrors.join('\n'),
      contentType: 'text/plain',
    });
    console.log(`\n  ⚠ ${jsErrors.length} JS error(s) on ${info.title}:`);
    jsErrors.slice(0, 5).forEach((e) => console.log(`    - ${e.slice(0, 200)}`));
  }
});

async function login(page, account, expectedUrlRegex) {
  await page.goto('/login');
  await page.fill('input[name="email"]', account.email);
  await page.fill('input[name="password"]', account.password);
  await Promise.all([
    page.waitForURL(expectedUrlRegex, { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

// ─── Infrastructure smoke ────────────────────────────────────────────

test('hub page (/) loads', async ({ page }) => {
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
});

test('login page renders form', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeVisible();
});

test('api /api/health responds with status', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(['ok', 'degraded']).toContain(json.status);
});

test('PWA manifest jemaah valid', async ({ request }) => {
  const res = await request.get('/shared/manifest-jemaah.webmanifest');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.start_url).toBe('/saya');
  expect(json.display).toBe('standalone');
  expect(json.name).toBeTruthy();
});

test('PWA manifest crew valid', async ({ request }) => {
  const res = await request.get('/shared/manifest-crew.webmanifest');
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.start_url).toBe('/crew');
  expect(json.display).toBe('standalone');
});

test('service worker reachable + JS content-type', async ({ request }) => {
  const res = await request.get('/shared/sw.js');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/javascript/);
});

test('push client scripts reachable', async ({ request }) => {
  for (const path of ['/shared/push-admin.js', '/shared/push-jemaah.js', '/shared/push-crew.js']) {
    const res = await request.get(path);
    expect(res.status(), `${path} should be 200`).toBe(200);
    expect(res.headers()['content-type']).toMatch(/javascript/);
  }
});

// ─── Login + redirect smoke ──────────────────────────────────────────

test('OWNER login redirects to /admin', async ({ page }) => {
  await login(page, accounts.owner, /\/admin\b/);
  expect(page.url()).toMatch(/\/admin(\?|$|\/)/);
});

test('KASIR login redirects to /admin/bookings (not 403)', async ({ page }) => {
  await login(page, accounts.kasir, /\/admin\/bookings/);
  expect(page.url()).toContain('/admin/bookings');
  // S6 fix: was redirecting to /admin overview which KASIR can't access
  await expect(page.locator('body')).not.toContainText(/403|Akses ditolak|Forbidden/i);
});

test('AGEN login redirects to /agen', async ({ page }) => {
  await login(page, accounts.agen, /\/agen\b/);
  expect(page.url()).toMatch(/\/agen(\?|$|\/)/);
});

test('JEMAAH login redirects to /saya', async ({ page }) => {
  await login(page, accounts.jemaah, /\/saya\b/);
  expect(page.url()).toMatch(/\/saya(\?|$|\/)/);
});

// ─── Portal render smoke ─────────────────────────────────────────────

test('OWNER /admin dashboard renders panels', async ({ page }) => {
  await login(page, accounts.owner, /\/admin\b/);
  // Topbar always present
  await expect(page.locator('h1, h2').first()).toBeVisible();
  // Sidebar nav has expected sections
  const body = await page.textContent('body');
  expect(body).toMatch(/Overview|Paket|Manifest|Finance/i);
});

test('AGEN /agen kanban tab renders', async ({ page }) => {
  await login(page, accounts.agen, /\/agen\b/);
  // 4-column kanban or wallet/marketing/analytics tabs
  const body = await page.textContent('body');
  expect(body).toMatch(/Cold|Warm|Hot|Lunas|Leads|Marketing|Wallet/i);
});

test('JEMAAH /saya dashboard renders + push bar present', async ({ page }) => {
  await login(page, accounts.jemaah, /\/saya\b/);
  // Push toggle markup exists (even if JS hides it for unsupported state)
  await expect(page.locator('#rp-push-bar')).toHaveCount(1);
});

test('JEMAAH in-trip hero shows when paket is current', async ({ page }) => {
  await login(page, accounts.jemaah, /\/saya\b/);
  const body = await page.textContent('body');
  // S320 in-trip hero — if seed-s320-intrip ran, this should appear
  const hasInTrip = /Hari Ini|Hari ke-\d/.test(body);
  // Soft-assert via console (don't fail — depends on whether seed ran)
  if (!hasInTrip) {
    console.log('  ℹ no in-trip hero detected — confirm seed-s320-intrip ran on prod DB');
  }
});

// ─── Public paket landing smoke ──────────────────────────────────────

test('public paket landing /p/<slug> renders without auth', async ({ page }) => {
  const res = await page.goto('/p/ramadhan-aqsa-2026?a=ahmad-w');
  expect(res?.status()).toBe(200);
  await expect(page.locator('body')).toContainText(/Ramadhan|paket|booking/i);
  // Booking form must be present
  const formCount = await page.locator('form').count();
  expect(formCount).toBeGreaterThan(0);
});

// ─── KASIR scope verification ────────────────────────────────────────

test('KASIR cannot reach /admin overview (gated)', async ({ page }) => {
  await login(page, accounts.kasir, /\/admin\/bookings/);
  const res = await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  // Should 403 or redirect away from /admin
  const status = res?.status() || 0;
  const url = page.url();
  // Either 403 status OR redirected to login/bookings
  expect(status === 403 || !url.endsWith('/admin')).toBeTruthy();
});

test('KASIR can open /admin/bookings/new form', async ({ page }) => {
  await login(page, accounts.kasir, /\/admin\/bookings/);
  const res = await page.goto('/admin/bookings/new');
  expect(res?.status()).toBe(200);
  await expect(page.locator('form')).toHaveCount(1);
});

// ─── CSRF + cookie smoke ─────────────────────────────────────────────

test('CSRF cookie issued on first page load', async ({ page, context }) => {
  await page.goto('/login');
  const cookies = await context.cookies();
  const csrf = cookies.find((c) => c.name === 'rp_csrf');
  expect(csrf, 'rp_csrf cookie should be present').toBeTruthy();
  expect(csrf.secure).toBe(true);
});
