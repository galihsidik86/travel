// Stage 266 — apply Lead.snoozedUntilAt migration inline.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  // Check whether column already exists (defensive; allows safe re-runs).
  const rows = await db.$queryRawUnsafe(
    "SHOW COLUMNS FROM `Lead` LIKE 'snoozedUntilAt'",
  );
  if (rows.length > 0) {
    console.log('[s266] Lead.snoozedUntilAt already exists — skipping.');
    return;
  }
  await db.$executeRawUnsafe(
    'ALTER TABLE `Lead` ADD COLUMN `snoozedUntilAt` DATETIME(3) NULL',
  );
  console.log('[s266] Lead.snoozedUntilAt added.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
