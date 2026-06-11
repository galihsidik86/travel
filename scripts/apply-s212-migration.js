import { db } from '../src/lib/db.js';

try {
  await db.$executeRawUnsafe(
    `ALTER TABLE \`PaketPickup\` ADD COLUMN \`maxCapacity\` INT NULL`,
  );
  console.log('S212 migration applied');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
