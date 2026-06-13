// Stage 260 — apply BookingGroup migration inline (avoids the Windows
// file-lock dance with `prisma migrate dev` while node --watch is running).
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`BookingGroup\` (
      \`groupKey\` VARCHAR(40) NOT NULL,
      \`label\` VARCHAR(120) NULL,
      \`notes\` TEXT NULL,
      \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`updatedAt\` DATETIME(3) NOT NULL,
      PRIMARY KEY (\`groupKey\`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);
  console.log('[s260] BookingGroup table created (or already existed).');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
