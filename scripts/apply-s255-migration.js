import { db } from '../src/lib/db.js';
try {
  await db.$executeRawUnsafe(`ALTER TABLE \`User\` ADD COLUMN \`recentEntities\` JSON NULL`);
  console.log('S255 migration applied');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
