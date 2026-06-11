import { db } from '../src/lib/db.js';

const SQL = `ALTER TABLE \`JemaahProfile\`
  ADD COLUMN \`dietary\` ENUM(
    'REGULAR',
    'VEGETARIAN',
    'HALAL_STRICT',
    'SOFT_TEXTURE',
    'DIABETIC',
    'OTHER'
  ) NOT NULL DEFAULT 'REGULAR',
  ADD COLUMN \`dietaryNotes\` VARCHAR(500) NULL`;

try {
  await db.$executeRawUnsafe(SQL);
  console.log('S210 migration applied');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
