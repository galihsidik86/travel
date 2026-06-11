import fs from 'node:fs/promises';
import { db } from '../src/lib/db.js';

try {
  const sql = await fs.readFile(
    new URL('../prisma/migrations/20260611150000_crew_dietary_brief/migration.sql', import.meta.url),
    'utf8',
  );
  // Strip comments + trailing ;
  const cleaned = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim().replace(/;$/, '');
  await db.$executeRawUnsafe(cleaned);
  console.log('S213 migration applied');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
