// Stage 135 — API key IP allowlist. requireApiScope rejects 403
// IP_NOT_ALLOWED when client IP doesn't match an entry. Quiet noop
// when allowedIps is null/empty (back-compat with every pre-S135 row).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { db, makeTag, tempUser, fakeReq } from './_helpers.js';
import {
  createApiKey, normaliseAllowedIps, ipMatchesAllowlist, clientIpFrom,
  requireApiScope, updateApiKeyAllowedIps,
} from '../src/services/apiKeys.js';

function actor(u) { return { id: u.id, email: u.email, role: u.role || 'OWNER' }; }

test('normaliseAllowedIps: comma + newline separated string → trimmed array', () => {
  assert.deepEqual(normaliseAllowedIps('1.1.1.1, 2.2.2.2'), ['1.1.1.1', '2.2.2.2']);
  assert.deepEqual(normaliseAllowedIps('1.1.1.1\n2.2.2.2\n  3.3.3.3  '), ['1.1.1.1', '2.2.2.2', '3.3.3.3']);
});

test('normaliseAllowedIps: empty / null / whitespace → null (any IP)', () => {
  assert.equal(normaliseAllowedIps(null), null);
  assert.equal(normaliseAllowedIps(''), null);
  assert.equal(normaliseAllowedIps('   ,  '), null);
  assert.equal(normaliseAllowedIps([]), null);
});

test('normaliseAllowedIps: caps array length at 50 (paste-bomb guard)', () => {
  const big = Array.from({ length: 200 }, (_, i) => `10.0.0.${i % 256}`);
  const out = normaliseAllowedIps(big);
  assert.equal(out.length, 50);
});

test('ipMatchesAllowlist: exact IPv4 match', () => {
  assert.equal(ipMatchesAllowlist('203.0.113.5', ['203.0.113.5']), true);
  assert.equal(ipMatchesAllowlist('203.0.113.6', ['203.0.113.5']), false);
});

test('ipMatchesAllowlist: CIDR /24', () => {
  assert.equal(ipMatchesAllowlist('192.168.1.42', ['192.168.1.0/24']), true);
  assert.equal(ipMatchesAllowlist('192.168.2.1', ['192.168.1.0/24']), false);
});

test('ipMatchesAllowlist: CIDR /32 = exact IP', () => {
  assert.equal(ipMatchesAllowlist('10.0.0.5', ['10.0.0.5/32']), true);
  assert.equal(ipMatchesAllowlist('10.0.0.6', ['10.0.0.5/32']), false);
});

test('ipMatchesAllowlist: 0.0.0.0/0 matches everything', () => {
  assert.equal(ipMatchesAllowlist('1.2.3.4', ['0.0.0.0/0']), true);
  assert.equal(ipMatchesAllowlist('203.0.113.99', ['0.0.0.0/0']), true);
});

test('ipMatchesAllowlist: multiple entries — any match wins', () => {
  const list = ['10.0.0.0/8', '203.0.113.5', '198.51.100.0/24'];
  assert.equal(ipMatchesAllowlist('10.5.5.5', list), true);
  assert.equal(ipMatchesAllowlist('203.0.113.5', list), true);
  assert.equal(ipMatchesAllowlist('198.51.100.42', list), true);
  assert.equal(ipMatchesAllowlist('8.8.8.8', list), false);
});

test('ipMatchesAllowlist: malformed entries silently ignored', () => {
  const list = ['typo-not-an-ip', '999.999.999.999', '10.0.0.5'];
  assert.equal(ipMatchesAllowlist('10.0.0.5', list), true);
  assert.equal(ipMatchesAllowlist('8.8.8.8', list), false);
});

test('clientIpFrom: prefers X-Forwarded-For first entry, strips IPv4-mapped IPv6', () => {
  assert.equal(clientIpFrom({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, ip: '127.0.0.1' }), '203.0.113.5');
  assert.equal(clientIpFrom({ headers: {}, ip: '::ffff:192.168.1.1' }), '192.168.1.1');
  assert.equal(clientIpFrom({ headers: {}, ip: '127.0.0.1' }), '127.0.0.1');
});

test('createApiKey: stores allowedIps when provided', async (t) => {
  const tag = makeTag('akI-create');
  const u = await tempUser(t, tag, { role: 'OWNER' });

  const k = await createApiKey({
    req: fakeReq, actor: actor(u),
    name: `test-${tag}`, scopes: ['read:bookings'],
    allowedIps: '203.0.113.5, 198.51.100.0/24',
  });
  t.after(() => db.apiKey.delete({ where: { id: k.id } }));
  assert.deepEqual(k.allowedIps, ['203.0.113.5', '198.51.100.0/24']);
});

test('createApiKey: omitted allowedIps → null (any IP allowed)', async (t) => {
  const tag = makeTag('akI-anyip');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u),
    name: `test-${tag}`, scopes: ['read:bookings'],
  });
  t.after(() => db.apiKey.delete({ where: { id: k.id } }));
  assert.equal(k.allowedIps, null);
});

test('updateApiKeyAllowedIps: no-op + skip-audit when value unchanged', async (t) => {
  const tag = makeTag('akI-noop');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u),
    name: `test-${tag}`, scopes: ['read:bookings'],
    allowedIps: '10.0.0.5',
  });
  t.after(async () => {
    await db.auditLog.deleteMany({ where: { entity: 'ApiKey', entityId: k.id } });
    await db.apiKey.delete({ where: { id: k.id } });
  });

  // Same value — no change
  await updateApiKeyAllowedIps({
    req: fakeReq, actor: actor(u), id: k.id, allowedIps: '10.0.0.5',
  });
  // Real change — write
  await updateApiKeyAllowedIps({
    req: fakeReq, actor: actor(u), id: k.id, allowedIps: '10.0.0.6',
  });

  const audits = await db.auditLog.findMany({
    where: { entity: 'ApiKey', entityId: k.id, action: 'UPDATE' },
  });
  assert.equal(audits.length, 1, 'exactly one UPDATE audit — no-op skip-audit');
});

test('requireApiScope: 403 IP_NOT_ALLOWED when client IP not in allowlist', async (t) => {
  const tag = makeTag('akI-block');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u),
    name: `test-${tag}`, scopes: ['read:bookings'],
    allowedIps: '203.0.113.5',  // only this IP allowed
  });
  t.after(() => db.apiKey.delete({ where: { id: k.id } }));

  const mw = requireApiScope('read:bookings');
  const req = {
    headers: {
      authorization: `Bearer ${k.token}`,
      'x-forwarded-for': '8.8.8.8',  // NOT in allowlist
    },
    ip: '8.8.8.8',
  };
  let statusCode = null;
  let payload = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(p) { payload = p; return this; },
  };
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'middleware must NOT call next');
  assert.equal(statusCode, 403);
  assert.equal(payload?.error?.code, 'IP_NOT_ALLOWED');
});

test('requireApiScope: passes when client IP matches CIDR entry', async (t) => {
  const tag = makeTag('akI-pass');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u),
    name: `test-${tag}`, scopes: ['read:bookings'],
    allowedIps: '198.51.100.0/24',
  });
  t.after(() => db.apiKey.delete({ where: { id: k.id } }));

  const mw = requireApiScope('read:bookings');
  const req = {
    headers: {
      authorization: `Bearer ${k.token}`,
      'x-forwarded-for': '198.51.100.42',  // in the /24
    },
    ip: '198.51.100.42',
  };
  let nextCalled = false;
  const res = { status() { return this; }, json() { return this; } };
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'middleware must pass through');
  assert.ok(req.apiKey, 'req.apiKey populated');
});

test('requireApiScope: passes when allowedIps is null (back-compat / any IP)', async (t) => {
  const tag = makeTag('akI-anyip-pass');
  const u = await tempUser(t, tag, { role: 'OWNER' });
  const k = await createApiKey({
    req: fakeReq, actor: actor(u),
    name: `test-${tag}`, scopes: ['read:bookings'],
    // no allowedIps
  });
  t.after(() => db.apiKey.delete({ where: { id: k.id } }));

  const mw = requireApiScope('read:bookings');
  const req = {
    headers: { authorization: `Bearer ${k.token}` },
    ip: '1.2.3.4',
  };
  let nextCalled = false;
  const res = { status() { return this; }, json() { return this; } };
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
