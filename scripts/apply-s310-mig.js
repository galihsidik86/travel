import { db } from '../src/lib/db.js';
import { promises as fs } from 'node:fs';
const sql = await fs.readFile('./prisma/migrations/20260616030000_trip_feedback/migration.sql', 'utf8');
// Split by ";\n" so each multi-line statement runs as one.
const stmts = sql.split(/;\s*[\r\n]+/).map((s) => s.trim()).filter((s) => s && !s.startsWith('--'));
for (const s of stmts) {
  console.log('---'); console.log(s.slice(0, 120) + (s.length > 120 ? '...' : ''));
  await db.$executeRawUnsafe(s);
}
await db.$disconnect();
console.log('OK');
