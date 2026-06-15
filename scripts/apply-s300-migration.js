// Stage 300 — apply AdminNotifPref table inline.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  const exists = await db.$queryRawUnsafe("SHOW TABLES LIKE 'AdminNotifPref'");
  if (exists.length > 0) { console.log('[s300] exists — skip'); return; }
  // Get current enum so the table types stay in sync with the live DB
  const rows = await db.$queryRawUnsafe("SHOW COLUMNS FROM `Notification` WHERE Field = 'type'");
  const enumSql = rows[0].Type; // e.g. enum('A','B',...)
  await db.$executeRawUnsafe(`
    CREATE TABLE \`AdminNotifPref\` (
      \`userId\`    VARCHAR(191) NOT NULL,
      \`type\`      ${enumSql} NOT NULL,
      \`enabled\`   BOOLEAN NOT NULL DEFAULT TRUE,
      \`updatedAt\` DATETIME(3) NOT NULL,
      PRIMARY KEY (\`userId\`, \`type\`),
      KEY \`AdminNotifPref_userId_idx\` (\`userId\`),
      CONSTRAINT \`AdminNotifPref_userId_fkey\`
        FOREIGN KEY (\`userId\`) REFERENCES \`User\`(\`id\`) ON DELETE CASCADE
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);
  console.log('[s300] AdminNotifPref created');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
