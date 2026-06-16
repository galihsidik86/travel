import { db } from '../src/lib/db.js';
await db.$executeRawUnsafe('ALTER TABLE `JemaahProfile` ADD COLUMN `notifEngagement` BOOLEAN NOT NULL DEFAULT TRUE');
const rows = await db.$queryRawUnsafe("SHOW COLUMNS FROM JemaahProfile LIKE 'notifEngagement'");
console.log(JSON.stringify(rows, null, 2));
await db.$disconnect();
