import { db } from '../src/lib/db.js';
import { promises as fs } from 'node:fs';
const sql = await fs.readFile('./prisma/migrations/20260616020000_engagement_optout_and_notif/migration.sql', 'utf8');
const stmts = sql.split(/;\s*[\r\n]/).map((s) => s.trim()).filter((s) => s && !s.startsWith('--'));
for (const s of stmts) {
  console.log('---'); console.log(s.slice(0, 100) + '...');
  await db.$executeRawUnsafe(s);
}
await db.$disconnect();
console.log('OK');
