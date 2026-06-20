import { db } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/auth.js';
const email = 'test-jemaah-s309@example.test';
const pw = await hashPassword('test12345');
const ex = await db.user.findUnique({ where: { email } });
if (!ex) {
  await db.user.create({
    data: { email, passwordHash: pw, role: 'JEMAAH', fullName: 'Test S309', phone: '+628111234567',
      jemaah: { create: { fullName: 'Test S309', phone: '+628111234567', email } } },
  });
  console.log('created');
} else { console.log('exists'); }
await db.$disconnect();
