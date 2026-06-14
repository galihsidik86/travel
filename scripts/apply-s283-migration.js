// Stage 283 + 284 — apply PaketAddon + BookingAddon tables inline.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  const a = await db.$queryRawUnsafe("SHOW TABLES LIKE 'PaketAddon'");
  if (a.length === 0) {
    await db.$executeRawUnsafe(`
      CREATE TABLE \`PaketAddon\` (
        \`id\`        VARCHAR(191) NOT NULL,
        \`paketId\`   VARCHAR(191) NOT NULL,
        \`name\`      VARCHAR(120) NOT NULL,
        \`priceIdr\`  DECIMAL(15, 2) NOT NULL,
        \`sortOrder\` INT NOT NULL DEFAULT 0,
        \`isActive\`  BOOLEAN NOT NULL DEFAULT TRUE,
        \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updatedAt\` DATETIME(3) NOT NULL,
        PRIMARY KEY (\`id\`),
        KEY \`PaketAddon_paketId_isActive_idx\` (\`paketId\`, \`isActive\`),
        CONSTRAINT \`PaketAddon_paketId_fkey\`
          FOREIGN KEY (\`paketId\`) REFERENCES \`Paket\`(\`id\`) ON DELETE CASCADE
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `);
    console.log('[s283] PaketAddon created');
  } else {
    console.log('[s283] PaketAddon exists — skip');
  }

  const b = await db.$queryRawUnsafe("SHOW TABLES LIKE 'BookingAddon'");
  if (b.length === 0) {
    await db.$executeRawUnsafe(`
      CREATE TABLE \`BookingAddon\` (
        \`id\`               VARCHAR(191) NOT NULL,
        \`bookingId\`        VARCHAR(191) NOT NULL,
        \`addonId\`          VARCHAR(191) NULL,
        \`nameSnapshot\`     VARCHAR(120) NOT NULL,
        \`priceIdrSnapshot\` DECIMAL(15, 2) NOT NULL,
        \`quantity\`         INT NOT NULL DEFAULT 1,
        \`createdAt\`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`createdByEmail\`   VARCHAR(190) NULL,
        PRIMARY KEY (\`id\`),
        KEY \`BookingAddon_bookingId_idx\` (\`bookingId\`),
        CONSTRAINT \`BookingAddon_bookingId_fkey\`
          FOREIGN KEY (\`bookingId\`) REFERENCES \`Booking\`(\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`BookingAddon_addonId_fkey\`
          FOREIGN KEY (\`addonId\`) REFERENCES \`PaketAddon\`(\`id\`) ON DELETE SET NULL
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `);
    console.log('[s284] BookingAddon created');
  } else {
    console.log('[s284] BookingAddon exists — skip');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
