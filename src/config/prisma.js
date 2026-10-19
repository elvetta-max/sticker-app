import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "./env.js";

let client = null;

/**
 * Lazily create the shared PrismaClient using the PostgreSQL driver adapter
 * (Prisma ORM v7). Connection is deferred until first query.
 * @returns {PrismaClient}
 */
export function getPrisma() {
  if (!client) {
    const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
    client = new PrismaClient({ adapter });
  }
  return client;
}

export async function disconnectPrisma() {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
