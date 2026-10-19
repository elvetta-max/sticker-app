import { CacheTtl, maintenanceCacheKey, readThroughCache } from "./cache.js";

/** Public response message while a tenant is in maintenance (context.md §4.18). */
export const MAINTENANCE_MESSAGE = "Service temporarily unavailable. Please try again soon.";

/**
 * Read a tenant's maintenance flag, cached in Redis for 60s (context.md §4.18).
 * The guard does one cheap key read per public request; admin toggles evict the key
 * so the flag flips immediately. An unknown tenant reads as `false` (its endpoints
 * will 404 on their own).
 *
 * @param {{ prisma: any, redis: any, appId: string }} args
 * @returns {Promise<boolean>}
 */
export async function readMaintenanceFlag({ prisma, redis, appId }) {
  return readThroughCache({
    redis,
    key: maintenanceCacheKey(appId),
    ttlSeconds: CacheTtl.maintenance,
    loader: async () => {
      const app = await prisma.app.findUnique({
        where: { id: appId },
        select: { maintenance_mode: true },
      });
      return app ? app.maintenance_mode : false;
    },
  });
}
