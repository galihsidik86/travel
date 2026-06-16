import { db } from '../src/lib/db.js';
const rows = await db.$queryRawUnsafe("SHOW COLUMNS FROM JemaahProfile LIKE 'notifEngagement'");
console.log(JSON.stringify(rows, null, 2));
await db.$disconnect();
