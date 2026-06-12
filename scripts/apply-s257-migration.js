import { db } from '../src/lib/db.js';
try {
  await db.$executeRawUnsafe(`ALTER TABLE \`Booking\` ADD COLUMN \`groupKey\` VARCHAR(40) NULL`);
  await db.$executeRawUnsafe(`ALTER TABLE \`Booking\` ADD INDEX \`Booking_groupKey_idx\` (\`groupKey\`)`);
  console.log('S257 migration applied');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
