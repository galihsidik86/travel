import { db } from '../src/lib/db.js';
// 1. Extend BookingStatus
await db.$executeRawUnsafe(`ALTER TABLE \`Booking\` MODIFY COLUMN \`status\` ENUM('PENDING','BOOKED','DP_PAID','PARTIAL','LUNAS','CANCELLED','REFUNDED','RESCHEDULED') NOT NULL DEFAULT 'PENDING'`);
console.log('BookingStatus enum: ok');
// 2. Add columns if missing
const cols = await db.$queryRawUnsafe("SHOW COLUMNS FROM Booking");
const have = new Set(cols.map((r) => r.Field));
if (!have.has('rescheduledToBookingId')) {
  await db.$executeRawUnsafe(`ALTER TABLE \`Booking\` ADD COLUMN \`rescheduledToBookingId\` VARCHAR(191) NULL`);
  console.log('rescheduledToBookingId: added');
}
if (!have.has('rescheduledAt')) {
  await db.$executeRawUnsafe(`ALTER TABLE \`Booking\` ADD COLUMN \`rescheduledAt\` DATETIME(3) NULL`);
  console.log('rescheduledAt: added');
}
if (!have.has('rescheduledByEmail')) {
  await db.$executeRawUnsafe(`ALTER TABLE \`Booking\` ADD COLUMN \`rescheduledByEmail\` VARCHAR(190) NULL`);
  console.log('rescheduledByEmail: added');
}
// 3. Unique index + FK (best-effort; skip if exists)
try {
  await db.$executeRawUnsafe('CREATE UNIQUE INDEX `Booking_rescheduledToBookingId_key` ON `Booking` (`rescheduledToBookingId`)');
  console.log('unique idx: added');
} catch (err) { console.log('unique idx: skip (', err.message.slice(0, 60), ')'); }
try {
  await db.$executeRawUnsafe('ALTER TABLE `Booking` ADD CONSTRAINT `Booking_rescheduledToBookingId_fkey` FOREIGN KEY (`rescheduledToBookingId`) REFERENCES `Booking`(`id`) ON DELETE SET NULL ON UPDATE CASCADE');
  console.log('fkey: added');
} catch (err) { console.log('fkey: skip (', err.message.slice(0, 60), ')'); }
// 4. Extend NotificationType + AdminNotifPref enums
const enumList = `'BOOKING_CREATED','PAYMENT_RECEIVED','BOOKING_LUNAS','REFUND_ISSUED','CANCEL_REQUESTED','PAYMENT_SETTLED_ADMIN','PAYOUT_CREATED','DOC_VERIFIED','INCIDENT_REPORTED','DAILY_DIGEST_OWNER','WEEKLY_DIGEST_OWNER','AGENT_WEEKLY_DIGEST','PAYOUT_REMINDER_OWNER','WAITLIST_SLOT_FREED','AGENT_STALLED_LEADS','TRAFFIC_ANOMALY_OWNER','LANDING_SLOW_OWNER','CREW_WEEKLY_DIGEST','TESTIMONIAL_PUBLISHED','FIRST_PAYMENT_THANKS','INCIDENT_ESCALATED','BOOKING_NOTE_MENTION','INCIDENT_SLA_BREACH_OWNER','TASK_OVERDUE_ESCALATION','API_KEY_SCOPE_DOWN_OWNER','WEBHOOK_HEALTH_OWNER','MANIFEST_CLOSE_NUDGE','KOMISI_STATEMENT_READY','AGENT_ANNUAL_RECAP','STATEMENT_UNREAD_NUDGE','PAYMENT_REMINDER','DOC_EXPIRING_SOON','PASSPORT_RENEWAL_REMINDER','CREW_DIETARY_BRIEF','PICKUP_REMINDER','INSTALLMENT_OVERDUE_ADMIN','DOC_VERIFY_SLA_ADMIN','CREW_DAILY_REPORT_REMINDER','CREW_DAILY_REPORT_MISSED_ADMIN','BOOKING_HANDOVER','POST_DEPARTURE_REENGAGE','BOOKING_CANCELLED_AGENT','REFUND_ISSUED_AGENT','BIRTHDAY_GREETING','ANNIVERSARY_REENGAGE','TRIP_FEEDBACK_REMINDER','NPS_DETRACTOR_ALERT','NPS_DETRACTOR_ESCALATED','JEMAAH_HELP_REQUEST','JEMAAH_HELP_ACK','JEMAAH_HELP_ESCALATED','BOOKING_RESCHEDULED','GENERIC'`;
await db.$executeRawUnsafe(`ALTER TABLE \`Notification\` MODIFY COLUMN \`type\` ENUM(${enumList}) NOT NULL`);
await db.$executeRawUnsafe(`ALTER TABLE \`AdminNotifPref\` MODIFY COLUMN \`type\` ENUM(${enumList}) NOT NULL`);
console.log('notif enums: ok');
await db.$disconnect();
