// Realign Notification.type enum with the Prisma schema. The S213 migration
// accidentally renamed INCIDENT_REPORTED to INCIDENT_CREATED/INCIDENT_RESOLVED
// — this restores the original and keeps CREW_DIETARY_BRIEF.
import { db } from '../src/lib/db.js';

const SQL = `ALTER TABLE \`Notification\` MODIFY COLUMN \`type\` ENUM(
  'BOOKING_CREATED',
  'PAYMENT_RECEIVED',
  'BOOKING_LUNAS',
  'REFUND_ISSUED',
  'CANCEL_REQUESTED',
  'PAYMENT_SETTLED_ADMIN',
  'PAYOUT_CREATED',
  'DOC_VERIFIED',
  'INCIDENT_REPORTED',
  'DAILY_DIGEST_OWNER',
  'WEEKLY_DIGEST_OWNER',
  'AGENT_WEEKLY_DIGEST',
  'PAYOUT_REMINDER_OWNER',
  'WAITLIST_SLOT_FREED',
  'AGENT_STALLED_LEADS',
  'TRAFFIC_ANOMALY_OWNER',
  'LANDING_SLOW_OWNER',
  'CREW_WEEKLY_DIGEST',
  'TESTIMONIAL_PUBLISHED',
  'FIRST_PAYMENT_THANKS',
  'INCIDENT_ESCALATED',
  'BOOKING_NOTE_MENTION',
  'INCIDENT_SLA_BREACH_OWNER',
  'TASK_OVERDUE_ESCALATION',
  'API_KEY_SCOPE_DOWN_OWNER',
  'WEBHOOK_HEALTH_OWNER',
  'MANIFEST_CLOSE_NUDGE',
  'KOMISI_STATEMENT_READY',
  'AGENT_ANNUAL_RECAP',
  'STATEMENT_UNREAD_NUDGE',
  'PAYMENT_REMINDER',
  'DOC_EXPIRING_SOON',
  'PASSPORT_RENEWAL_REMINDER',
  'CREW_DIETARY_BRIEF',
  'GENERIC'
) NOT NULL`;

try {
  // First clean up any empty-string rows that may have landed from the bad enum
  const cleaned = await db.$executeRawUnsafe(`DELETE FROM \`Notification\` WHERE \`type\` = ''`);
  console.log(`cleaned ${cleaned} empty-type rows`);
  await db.$executeRawUnsafe(SQL);
  console.log('Notification.type enum realigned');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
