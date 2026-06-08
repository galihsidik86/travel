// Stage 116 — OpenAPI spec + docs surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../src/app.js';
import { buildOpenApiSpec } from '../src/services/openApiSpec.js';

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
      res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('buildOpenApiSpec: returns OpenAPI 3.1 shape with key paths', () => {
  const spec = buildOpenApiSpec();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.info?.title?.includes('Religio'));
  // Three paths defined
  assert.ok(spec.paths['/api/v1/bookings']);
  assert.ok(spec.paths['/api/v1/bookings/{id}']);
  assert.ok(spec.paths['/api/v1/paket']);
  // Bearer security
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
  // Schemas referenced
  assert.ok(spec.components.schemas.Booking);
  assert.ok(spec.components.schemas.Pagination);
});

test('/api/v1/openapi.json: returns spec without auth', async (t) => {
  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/openapi.json');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    const body = JSON.parse(res.body);
    assert.equal(body.openapi, '3.1.0');
    // baseUrl reflects the request host
    assert.ok(Array.isArray(body.servers));
    assert.ok(body.servers[0]?.url);
  } finally { await close(srv); }
});

test('/api/v1/docs: returns Swagger UI HTML', async (t) => {
  const srv = await startServer();
  try {
    const res = await req(srv, 'GET', '/api/v1/docs');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/html/);
    assert.match(res.body, /SwaggerUIBundle/);
    assert.match(res.body, /\/api\/v1\/openapi\.json/);
  } finally { await close(srv); }
});

test('buildOpenApiSpec: baseUrl reflected in servers[]', () => {
  const spec = buildOpenApiSpec({ baseUrl: 'https://api.example.com' });
  assert.equal(spec.servers[0].url, 'https://api.example.com');
});
