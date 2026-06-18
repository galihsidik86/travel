import { db } from '../src/lib/db.js';
const b = await db.booking.findFirst({ where: { status: 'LUNAS' }, orderBy: { createdAt: 'desc' } });
if (!b) { console.log('no LUNAS'); process.exit(0); }
// Inject a JEMAAH_HELP_REQUEST notif for this booking (simulating S321 submit)
await db.notification.create({
  data: {
    type: 'JEMAAH_HELP_REQUEST', channel: 'EMAIL',
    recipientEmail: 'admin-smoke@test',
    subject: 'SOS', body: 'smoke',
    status: 'SENT', sentAt: new Date(),
    payload: { messagePreview: 'Saya butuh bantuan urgent — smoke test' },
    relatedEntity: 'Booking', relatedEntityId: b.id,
  },
});
console.log('seeded help request for', b.id);
await db.$disconnect();
