import { PrismaClient } from '@prisma/client';
import { env, isDev } from '../env.js';

const globalForPrisma = globalThis;

export const db =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log: isDev ? ['warn', 'error'] : ['error'],
    datasources: env.DATABASE_URL ? { db: { url: env.DATABASE_URL } } : undefined,
  });

if (isDev) globalForPrisma.__prisma = db;

export async function pingDb() {
  try {
    await db.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function disconnectDb() {
  await db.$disconnect();
}
