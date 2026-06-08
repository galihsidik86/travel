// Stage 123 — OpenAPI codegen check smoke test. Asserts the codegen
// flow itself works (any spec drift that breaks types will throw here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import openapiTS, { astToString } from 'openapi-typescript';

import { buildOpenApiSpec } from '../src/services/openApiSpec.js';

test('openapi spec produces non-empty TypeScript types via codegen', async () => {
  const spec = buildOpenApiSpec({ baseUrl: 'http://localhost' });
  const ast = await openapiTS(spec);
  const ts = astToString(ast);
  // Sanity — key types must appear in the generated source. Their
  // absence indicates a spec accident (renamed component, dropped path).
  assert.match(ts, /Booking\b/, 'Booking schema generated');
  assert.match(ts, /BookingWithPayments\b/, 'BookingWithPayments generated');
  assert.match(ts, /Pagination\b/, 'Pagination generated');
  assert.match(ts, /\/api\/v1\/bookings/, 'bookings path generated');
  assert.match(ts, /\/api\/v1\/audit/, 'audit path generated');
  assert.match(ts, /\/api\/v1\/paket/, 'paket path generated');
});

test('openapi spec passes round-trip JSON serialise → parse', () => {
  const spec = buildOpenApiSpec({ baseUrl: 'http://localhost' });
  const text = JSON.stringify(spec);
  const back = JSON.parse(text);
  assert.equal(back.openapi, '3.1.0');
  // Three (now four — added /audit in S120) endpoints
  assert.ok(back.paths['/api/v1/bookings']);
  assert.ok(back.paths['/api/v1/audit']);
});
