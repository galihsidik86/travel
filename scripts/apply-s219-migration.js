import fs from 'node:fs/promises';
import { db } from '../src/lib/db.js';

try {
  const sql = await fs.readFile(
    new URL('../prisma/migrations/20260612120000_pickup_reminder/migration.sql', import.meta.url),
    'utf8',
  );
  const cleaned = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim().replace(/;$/, '');
  await db.$executeRawUnsafe(cleaned);
  console.log('S219 migration applied');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
