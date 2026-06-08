// Stage 123 — OpenAPI codegen smoke check.
//
// Verifies our /api/v1/openapi.json contract still produces a valid
// TypeScript SDK that compiles. Workflow:
//
//   1. Serialise the spec via buildOpenApiSpec()
//   2. Run `openapi-typescript` to generate a .d.ts of operation types
//   3. Run `tsc` (no-emit) over a smoke .ts file that uses key types
//      from the generated output (booking shape, paginated envelope,
//      audit row). Any spec drift that breaks those types → compile
//      error → CI fail.
//
// Why this matters: partners diff the spec to detect compat breaks.
// If our spec accidentally drops a field (e.g. we rename `bookingNo`
// to `booking_no`), the codegen still produces SOMETHING but it'll
// have a different shape — and our smoke.ts asserts the OLD shape.
// Compilation failure = breaking change detected pre-merge.
//
// Run: `npm run check:openapi-sdk`
// Exit 0 = ok, exit 1 = spec drifted in a way that breaks partners.

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import openapiTS, { astToString } from 'openapi-typescript';

import { buildOpenApiSpec } from '../src/services/openApiSpec.js';

const TMP = path.resolve('.openapi-check');
const SPEC = path.join(TMP, 'openapi.json');
const TYPES = path.join(TMP, 'types.d.ts');
const SMOKE = path.join(TMP, 'smoke.ts');
const TSCONFIG = path.join(TMP, 'tsconfig.json');

function clean() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
}

function run(cmd, args, opts = {}) {
  console.log(`→ ${cmd} ${args.join(' ')}${opts.cwd ? '  (cwd ' + opts.cwd + ')' : ''}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`✕ ${cmd} exited ${r.status}`);
    process.exit(r.status || 1);
  }
}

clean();
mkdirSync(TMP, { recursive: true });

// 1. Spec
const spec = buildOpenApiSpec({ baseUrl: 'http://localhost' });
writeFileSync(SPEC, JSON.stringify(spec, null, 2));

// 2. Codegen — use the JS API directly (CLI choked on spaces in our
// local dev path; npx-spawn paths on Windows are fragile).
const ast = await openapiTS(spec);
writeFileSync(TYPES, astToString(ast));

// 3. Smoke .ts asserting the key contract shapes
writeFileSync(SMOKE, `
// Auto-generated smoke file — DO NOT EDIT. Asserts /api/v1 contract
// hasn't drifted in a way that would break partner SDK consumers.
import type { paths, components } from './types';

// Pagination envelope is shared across endpoints
type Pagination = components['schemas']['Pagination'];
const _pg: Pagination = { page: 1, limit: 50, total: 0, totalPages: 0, hasMore: false };

// Booking shape — drop a field or rename + this fails to compile
type Booking = components['schemas']['Booking'];
const _b: Pick<Booking, 'id' | 'bookingNo' | 'status' | 'kelas' | 'paxCount' | 'totalAmountIdr' | 'paidAmountIdr'> = {
  id: 'x',
  bookingNo: 'RP-2026-00001',
  status: 'PENDING',
  kelas: 'QUAD',
  paxCount: 1,
  totalAmountIdr: 0,
  paidAmountIdr: 0,
};

// Single-booking detail must include payments[]
type BookingWithPayments = components['schemas']['BookingWithPayments'];
type _BWPayments = NonNullable<BookingWithPayments>;

// Path operations must exist
type ListBookingsOp = paths['/api/v1/bookings']['get'];
type GetBookingOp   = paths['/api/v1/bookings/{id}']['get'];
type AuditOp        = paths['/api/v1/audit']['get'];
type PaketOp        = paths['/api/v1/paket']['get'];

// Quiet "unused" warnings
void _pg; void _b; void null as unknown as _BWPayments;
void null as unknown as ListBookingsOp;
void null as unknown as GetBookingOp;
void null as unknown as AuditOp;
void null as unknown as PaketOp;
`);

// 4. Minimal tsconfig for the check
writeFileSync(TSCONFIG, JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['smoke.ts', 'types.d.ts'],
}, null, 2));

// Run tsc with cwd = temp dir + relative project arg, so spaces in
// the absolute path don't trip the shell-split.
run('npx', ['tsc', '--project', 'tsconfig.json'], { cwd: TMP });

console.log('✓ OpenAPI spec compiles cleanly against the smoke contract.');
clean();
