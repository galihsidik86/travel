// =============================================================
// Religio Pro — restore the Playwright smoke-test JEMAAH account
//
// seed-demo-realistic.js's cleanup step deleted
// test-jemaah-s309@example.test as an orphaned smoke-test artifact
// (it was only linked to the 2 junk "Smoke In-Trip Paket S320"
// bookings, which were legitimately removed). But
// tests/playwright/smoke-prod.spec.js hardcodes this exact account
// for its JEMAAH login/portal-render checks — deleting it broke that
// suite for future deploy verification.
//
// This recreates a minimal, credential-only version (no bookings) so
// `npx playwright test` against production works again. It does NOT
// recreate the old smoke paket/booking — those were genuinely
// disposable; only the login account itself is load-bearing for the
// test suite.
//
// Usage: node --env-file-if-exists=.env scripts/patch-restore-smoke-jemaah.js
// =============================================================

import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/auth.js';

const db = new PrismaClient();

async function main() {
  const email = 'test-jemaah-s309@example.test';
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) { console.log('already exists — nothing to do'); return; }

  const user = await db.user.create({
    data: {
      email, passwordHash: await hashPassword('test12345'),
      role: 'JEMAAH', fullName: 'Test Jemaah S309', phone: '0800-0000-0309',
    },
  });
  await db.jemaahProfile.create({
    data: { userId: user.id, fullName: 'Test Jemaah S309', phone: '0800-0000-0309' },
  });
  console.log(`restored ${email} (userId=${user.id})`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
