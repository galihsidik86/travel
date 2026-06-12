import { db } from '../src/lib/db.js';
try {
  await db.$executeRawUnsafe(`ALTER TABLE \`Booking\` ADD COLUMN \`autoTaggedSeen\` JSON NULL`);
  console.log('S232 migration applied');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
