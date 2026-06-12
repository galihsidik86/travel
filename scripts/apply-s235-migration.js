import { db } from '../src/lib/db.js';
try {
  await db.$executeRawUnsafe(`ALTER TABLE \`Payment\` ADD COLUMN \`refundReasonCode\` VARCHAR(40) NULL`);
  await db.$executeRawUnsafe(`ALTER TABLE \`Payment\` ADD INDEX \`Payment_refundReasonCode_idx\` (\`refundReasonCode\`)`);
  console.log('S235 migration applied');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
