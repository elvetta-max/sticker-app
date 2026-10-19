import { AppError } from "../../lib/errors.js";
import { CacheTtl, adsCacheKey, versionCacheKey, readThroughCache } from "../../lib/cache.js";

/** Columns the public version endpoint needs. */
export const VERSION_SELECT = {
  id: true,
  target_version: true,
  force_update: true,
  maintenance_mode: true,
};

/** Columns the public ads endpoint exposes (all six AdMob units + master switch). */
export const ADS_SELECT = {
  id: true,
  ads_enabled: true,
  admob_banner: true,
  admob_interstitial: true,
  admob_rewarded: true,
  admob_rewarded_interstitial: true,
  admob_openad: true,
  admob_native: true,
};

/** Public version payload (context.md §4.12). `maintenance_mode` lets the client show
 * its maintenance screen straight from the (exempt) version call (§4.18). @param {object} app */
export function toVersionConfig(app) {
  return {
    app_id: app.id,
    target_version: app.target_version,
    force_update: app.force_update,
    maintenance_mode: app.maintenance_mode,
  };
}

/** Public ad-config payload (context.md §4.13). @param {object} app */
export function toAdsConfig(app) {
  return {
    app_id: app.id,
    ads_enabled: app.ads_enabled,
    admob_banner: app.admob_banner,
    admob_interstitial: app.admob_interstitial,
    admob_rewarded: app.admob_rewarded,
    admob_rewarded_interstitial: app.admob_rewarded_interstitial,
    admob_openad: app.admob_openad,
    admob_native: app.admob_native,
  };
}

/**
 * Load one tenant's config, or 404 (unknown `app_id` never leaks tenant existence).
 * @param {{ prisma: any, app_id: string, select: object }} args
 */
async function loadApp({ prisma, app_id, select }) {
  const app = await prisma.app.findUnique({ where: { id: app_id }, select });
  if (!app) {
    throw AppError.notFound("App not found.");
  }
  return app;
}

/**
 * Public version info, served through a 60s Redis cache (context.md §4.12 — the
 * hottest endpoint on app launch). The per-request `update_required` flag is derived
 * from the cached config and the client's reported `current_version`.
 *
 * @param {{ prisma: any, redis: any, app_id: string, current_version?: number }} args
 */
export async function getAppVersion({ prisma, redis, app_id, current_version = 0 }) {
  const config = await readThroughCache({
    redis,
    key: versionCacheKey(app_id),
    ttlSeconds: CacheTtl.version,
    loader: async () => toVersionConfig(await loadApp({ prisma, app_id, select: VERSION_SELECT })),
  });

  return {
    ...config,
    update_required: config.force_update && current_version < config.target_version,
  };
}

/**
 * Public ad configuration, served through a 60s Redis cache (context.md §4.13).
 * @param {{ prisma: any, redis: any, app_id: string }} args
 */
export async function getAppAds({ prisma, redis, app_id }) {
  return readThroughCache({
    redis,
    key: adsCacheKey(app_id),
    ttlSeconds: CacheTtl.ads,
    loader: async () => toAdsConfig(await loadApp({ prisma, app_id, select: ADS_SELECT })),
  });
}
