import { z } from "zod";

/** AdMob unit-ID format, e.g. `ca-app-pub-1234567890123456/1234567890` (context.md §4.13). */
export const ADMOB_UNIT_PATTERN = /^ca-app-pub-\d+\/[\w-]+$/;

const unitId = z
  .string()
  .trim()
  .max(128)
  .regex(ADMOB_UNIT_PATTERN, "Invalid AdMob unit ID format.");

/** Body for `PUT /api/admin/apps/{app_id}/version` (context.md §4.12). */
export const updateAppVersionSchema = z.object({
  target_version: z.coerce.number().int().min(1),
  force_update: z.boolean(),
});

/** Body for `PUT /api/admin/apps/{app_id}/maintenance` (context.md §4.18). */
export const updateAppMaintenanceSchema = z.object({
  maintenance_mode: z.boolean(),
});

/**
 * Body for `PUT /api/admin/apps/{app_id}/ads` (context.md §4.13). Every unit is
 * optional; a provided unit must match the AdMob format, and `null` clears it.
 */
export const updateAppAdsSchema = z.object({
  ads_enabled: z.boolean().optional(),
  admob_banner: unitId.nullable().optional(),
  admob_interstitial: unitId.nullable().optional(),
  admob_rewarded: unitId.nullable().optional(),
  admob_rewarded_interstitial: unitId.nullable().optional(),
  admob_openad: unitId.nullable().optional(),
  admob_native: unitId.nullable().optional(),
});
