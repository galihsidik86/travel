import { db } from '../src/lib/db.js';
const jem = await db.user.findUnique({
  where: { email: 'test-jemaah-s309@example.test' },
  include: { jemaah: true },
});
if (!jem) { console.log('no test jemaah'); process.exit(0); }

// Build a paket whose window covers today: depart 3 days ago, return 6 days ahead.
const dep = new Date(); dep.setHours(0,0,0,0); dep.setDate(dep.getDate() - 3);
const ret = new Date(dep.getTime() + 9 * 86_400_000);
const slug = 'smoke-intrip-' + Date.now();
const paket = await db.paket.create({
  data: {
    slug, title: 'Smoke In-Trip Paket S320',
    departureDate: dep, returnDate: ret,
    durationDays: 10, inclusions: [], exclusions: [],
    kursiTotal: 10, status: 'ACTIVE',
    prices: { create: [{ kelas: 'QUAD', priceIdr: '1000000' }] },
    days: { create: Array.from({length:10},(_,i)=>({
      dayNumber: i+1,
      title: i===3 ? 'Ziarah Masjid Quba' : `Day ${i+1} itinerary`,
      description: i===3 ? 'Berangkat dari lobi pukul 15:30. Pakai ihram.' : 'Agenda harian',
    })) },
  },
});
const bookingNo = 'RP-SMOKE-S320-' + Math.random().toString(36).slice(2,6).toUpperCase();
const b = await db.booking.create({
  data: {
    bookingNo,
    paketId: paket.id, jemaahId: jem.jemaah.id, jemaahUserId: jem.id,
    kelas: 'QUAD', paxCount: 1, totalAmount: '1000000', paidAmount: '1000000', status: 'LUNAS',
  },
});
console.log('created booking:', b.bookingNo, 'paket:', paket.slug);
await db.$disconnect();
