import { db } from '../src/lib/db.js';

const SQLS = [
  [
    '20260612130000_pickup_driver',
    `ALTER TABLE \`PaketPickup\`
      ADD COLUMN \`driverName\`  VARCHAR(120) NULL,
      ADD COLUMN \`driverPhone\` VARCHAR(30)  NULL,
      ADD COLUMN \`plateNumber\` VARCHAR(20)  NULL`,
  ],
  [
    '20260612140000_paket_wa_group',
    `ALTER TABLE \`Paket\` ADD COLUMN \`waGroupUrl\` VARCHAR(500) NULL`,
  ],
];

try {
  for (const [name, sql] of SQLS) {
    await db.$executeRawUnsafe(sql);
    console.log(`applied ${name}`);
  }
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
