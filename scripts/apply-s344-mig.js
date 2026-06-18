import { db } from '../src/lib/db.js';
const cols = await db.$queryRawUnsafe("SHOW COLUMNS FROM Booking");
const have = new Set(cols.map((r) => r.Field));
if (!have.has('rescheduleReasonCode')) {
  await db.$executeRawUnsafe(`ALTER TABLE \`Booking\` ADD COLUMN \`rescheduleReasonCode\` ENUM('JEMAAH_REQUEST','DOCUMENT_DELAY','HEALTH','FINANCIAL','PAKET_FULL','SCHEDULE_CONFLICT','OPERATOR_INITIATED','OTHER') NULL`);
  console.log('column added');
} else { console.log('column exists'); }
try {
  await db.$executeRawUnsafe('CREATE INDEX `Booking_rescheduleReasonCode_idx` ON `Booking` (`rescheduleReasonCode`)');
  console.log('index added');
} catch (err) { console.log('index skip:', err.message.slice(0, 60)); }
await db.$disconnect();
