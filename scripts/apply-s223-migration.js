import { db } from '../src/lib/db.js';
try {
  await db.$executeRawUnsafe(
    `ALTER TABLE \`Paket\` ADD COLUMN \`requiredDocs\` JSON NULL`,
  );
  console.log('S223 migration applied');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
