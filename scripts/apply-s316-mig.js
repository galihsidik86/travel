import { db } from '../src/lib/db.js';
// 1. Add columns to TripFeedback. Use IF NOT EXISTS where MariaDB supports it,
//    but to be safe, fetch existing columns first.
const existing = await db.$queryRawUnsafe("SHOW COLUMNS FROM TripFeedback");
const have = new Set(existing.map((r) => r.Field));
const cols = [
  ['followUpStatus', "ENUM('NEW','ACKED','RESOLVED','UNREACHABLE') NOT NULL DEFAULT 'NEW'"],
  ['followUpNote', 'TEXT NULL'],
  ['followedUpAt', 'DATETIME(3) NULL'],
  ['followedUpByEmail', 'VARCHAR(190) NULL'],
  ['escalatedAt', 'DATETIME(3) NULL'],
];
for (const [name, type] of cols) {
  if (!have.has(name)) {
    await db.$executeRawUnsafe(`ALTER TABLE \`TripFeedback\` ADD COLUMN \`${name}\` ${type}`);
    console.log('added column:', name);
  } else {
    console.log('skip column:', name);
  }
}
// 2. Index
try {
  await db.$executeRawUnsafe('CREATE INDEX `TripFeedback_followUpStatus_score_idx` ON `TripFeedback` (`followUpStatus`, `score`)');
  console.log('added index');
} catch (err) {
  if (err.message.match(/duplicate|exists/i)) console.log('skip index'); else throw err;
}
// 3. Enum ALTER on Notification + AdminNotifPref
const enumList = `'BOOKING_CREATED','PAYMENT_RECEIVED','BOOKING_LUNAS','REFUND_ISSUED','CANCEL_REQUESTED','PAYMENT_SETTLED_ADMIN','PAYOUT_CREATED','DOC_VERIFIED','INCIDENT_REPORTED','DAILY_DIGEST_OWNER','WEEKLY_DIGEST_OWNER','AGENT_WEEKLY_DIGEST','PAYOUT_REMINDER_OWNER','WAITLIST_SLOT_FREED','AGENT_STALLED_LEADS','TRAFFIC_ANOMALY_OWNER','LANDING_SLOW_OWNER','CREW_WEEKLY_DIGEST','TESTIMONIAL_PUBLISHED','FIRST_PAYMENT_THANKS','INCIDENT_ESCALATED','BOOKING_NOTE_MENTION','INCIDENT_SLA_BREACH_OWNER','TASK_OVERDUE_ESCALATION','API_KEY_SCOPE_DOWN_OWNER','WEBHOOK_HEALTH_OWNER','MANIFEST_CLOSE_NUDGE','KOMISI_STATEMENT_READY','AGENT_ANNUAL_RECAP','STATEMENT_UNREAD_NUDGE','PAYMENT_REMINDER','DOC_EXPIRING_SOON','PASSPORT_RENEWAL_REMINDER','CREW_DIETARY_BRIEF','PICKUP_REMINDER','INSTALLMENT_OVERDUE_ADMIN','DOC_VERIFY_SLA_ADMIN','CREW_DAILY_REPORT_REMINDER','CREW_DAILY_REPORT_MISSED_ADMIN','BOOKING_HANDOVER','POST_DEPARTURE_REENGAGE','BOOKING_CANCELLED_AGENT','REFUND_ISSUED_AGENT','BIRTHDAY_GREETING','ANNIVERSARY_REENGAGE','TRIP_FEEDBACK_REMINDER','NPS_DETRACTOR_ALERT','NPS_DETRACTOR_ESCALATED','GENERIC'`;
await db.$executeRawUnsafe(`ALTER TABLE \`Notification\` MODIFY COLUMN \`type\` ENUM(${enumList}) NOT NULL`);
console.log('Notification enum: ok');
await db.$executeRawUnsafe(`ALTER TABLE \`AdminNotifPref\` MODIFY COLUMN \`type\` ENUM(${enumList}) NOT NULL`);
console.log('AdminNotifPref enum: ok');
await db.$disconnect();
