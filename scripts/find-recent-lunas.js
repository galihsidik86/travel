import { db } from '../src/lib/db.js';
const b = await db.booking.findFirst({ where: { status: 'LUNAS' }, orderBy: { createdAt: 'desc' } });
console.log(b?.id || '');
await db.$disconnect();
