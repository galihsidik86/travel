// Stage 289 — apply PublicInquiry table inline.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  const exists = await db.$queryRawUnsafe("SHOW TABLES LIKE 'PublicInquiry'");
  if (exists.length > 0) {
    console.log('[s289] PublicInquiry exists — skip');
    return;
  }
  await db.$executeRawUnsafe(`
    CREATE TABLE \`PublicInquiry\` (
      \`id\`               VARCHAR(191) NOT NULL,
      \`paketSlug\`        VARCHAR(190) NULL,
      \`agentSlug\`        VARCHAR(190) NULL,
      \`fullName\`         VARCHAR(190) NOT NULL,
      \`phone\`            VARCHAR(30)  NOT NULL,
      \`email\`            VARCHAR(190) NULL,
      \`message\`          TEXT NULL,
      \`status\`           ENUM('NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED') NOT NULL DEFAULT 'NEW',
      \`ip\`               VARCHAR(64) NULL,
      \`userAgent\`        TEXT NULL,
      \`convertedLeadId\`  VARCHAR(191) NULL,
      \`convertedAt\`      DATETIME(3) NULL,
      \`archivedAt\`       DATETIME(3) NULL,
      \`archivedReason\`   VARCHAR(500) NULL,
      \`createdAt\`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`updatedAt\`        DATETIME(3) NOT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`PublicInquiry_convertedLeadId_key\` (\`convertedLeadId\`),
      KEY \`PublicInquiry_status_createdAt_idx\` (\`status\`, \`createdAt\`),
      KEY \`PublicInquiry_paketSlug_idx\` (\`paketSlug\`),
      KEY \`PublicInquiry_agentSlug_idx\` (\`agentSlug\`),
      KEY \`PublicInquiry_phone_idx\` (\`phone\`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);
  console.log('[s289] PublicInquiry created');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
