// Stage 268 — apply Booking.installmentSchedule migration inline.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  const rows = await db.$queryRawUnsafe(
    "SHOW COLUMNS FROM `Booking` LIKE 'installmentSchedule'",
  );
  if (rows.length > 0) {
    console.log('[s268] Booking.installmentSchedule already exists — skipping.');
    return;
  }
  await db.$executeRawUnsafe(
    'ALTER TABLE `Booking` ADD COLUMN `installmentSchedule` JSON NULL',
  );
  console.log('[s268] Booking.installmentSchedule added.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
