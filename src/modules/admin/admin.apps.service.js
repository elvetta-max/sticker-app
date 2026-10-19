import { AppError } from "../../lib/errors.js";
import { adsCacheKey, versionCacheKey, maintenanceCacheKey, evictKeys } from "../../lib/cache.js";
import { toVersionConfig, toAdsConfig, ADS_SELECT } from "../apps/app.service.js";

/**
 * Verify the tenant exists before an admin mutation (404 otherwise).
 * @param {any} prisma
 * @param {string} app_id
 */
async function assertApp(prisma, app_id) {
  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }
}

/**
 * Update a tenant's version policy and evict its cached version config
 * (context.md §4.12).
 *
 * @param {{ prisma: any, redis: any, app_id: string, target_version: number, force_update: boolean }} args
 */
export async function setAppVersion({ prisma, redis, app_id, target_version, force_update }) {
  await assertApp(prisma, app_id);

  const updated = await prisma.app.update({
    where: { id: app_id },
    data: { target_version, force_update },
    select: { id: true, target_version: true, force_update: true, maintenance_mode: true },
  });

  await evictKeys(redis, [versionCacheKey(app_id)]);
  return toVersionConfig(updated);
}

/**
 * Update a tenant's ad configuration and evict its cached ad config
 * (context.md §4.13). Only provided fields change; `null` clears a unit.
 *
 * @param {{ prisma: any, redis: any, app_id: string, body: object }} args
 */
export async function setAppAds({ prisma, redis, app_id, body }) {
  await assertApp(prisma, app_id);

  const data = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) data[key] = value;
  }

  const updated = await prisma.app.update({
    where: { id: app_id },
    data,
    select: ADS_SELECT,
  });

  await evictKeys(redis, [adsCacheKey(app_id)]);
  return toAdsConfig(updated);
}

/** Maintenance payload (context.md §4.18). @param {object} app */
export function toMaintenanceConfig(app) {
  return { app_id: app.id, maintenance_mode: app.maintenance_mode };
}

/**
 * Toggle a tenant's maintenance mode (context.md §4.18). Evicts both the maintenance
 * flag and the version cache so public traffic is gated (and clients see the flag on
 * the exempt version call) immediately.
 *
 * @param {{ prisma: any, redis: any, app_id: string, maintenance_mode: boolean }} args
 */
export async function setAppMaintenance({ prisma, redis, app_id, maintenance_mode }) {
  await assertApp(prisma, app_id);

  const updated = await prisma.app.update({
    where: { id: app_id },
    data: { maintenance_mode },
    select: { id: true, maintenance_mode: true },
  });

  await evictKeys(redis, [versionCacheKey(app_id), maintenanceCacheKey(app_id)]);
  return toMaintenanceConfig(updated);
}
