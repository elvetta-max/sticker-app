import { Queue } from "bullmq";
import { redisConnectionOptions } from "./connection.js";
import { TRENDING_REBUILD_MS } from "../lib/trending.js";
import {
  SEARCH_TRENDING_REBUILD_MS,
  SEARCH_SUGGEST_REBUILD_MS,
  SEARCH_PURGE_CRON,
} from "../lib/search.js";
import { SOTD_CRON } from "../lib/sotd.js";

export const MAINTENANCE_QUEUE_NAME = "maintenance";

/** Jobs handled by the maintenance worker. */
export const MaintenanceJob = Object.freeze({
  TRENDING_RECOMPUTE: "trending:recompute",
  SEARCH_TRENDING_RECOMPUTE: "search:trending-recompute",
  SEARCH_SUGGEST_RECOMPUTE: "search:suggest-recompute",
  SOTD_PICK: "sotd:pick",
  SEARCH_PURGE: "search:purge",
});

let queue = null;

/** @returns {Queue} */
export function getMaintenanceQueue() {
  queue ??= new Queue(MAINTENANCE_QUEUE_NAME, { connection: redisConnectionOptions() });
  return queue;
}

/**
 * Register the repeatable trending-recompute job (every 5 minutes, §5.1).
 * `jobId` keeps the schedule idempotent across worker restarts.
 * @param {number} [intervalMs]
 */
export function scheduleTrendingRecompute(intervalMs = TRENDING_REBUILD_MS) {
  return getMaintenanceQueue().add(
    MaintenanceJob.TRENDING_RECOMPUTE,
    {},
    {
      repeat: { every: intervalMs },
      jobId: "trending-recompute",
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

/**
 * Register the repeatable trending-search rebuild (every 10 minutes, §4.6).
 * @param {number} [intervalMs]
 */
export function scheduleSearchTrendingRecompute(intervalMs = SEARCH_TRENDING_REBUILD_MS) {
  return getMaintenanceQueue().add(
    MaintenanceJob.SEARCH_TRENDING_RECOMPUTE,
    {},
    {
      repeat: { every: intervalMs },
      jobId: "search-trending-recompute",
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

/**
 * Register the daily SearchQuery purge (03:00 UTC, §4.6).
 * @param {string} [cron]
 */
export function scheduleSearchPurge(cron = SEARCH_PURGE_CRON) {
  return getMaintenanceQueue().add(
    MaintenanceJob.SEARCH_PURGE,
    {},
    {
      repeat: { pattern: cron },
      jobId: "search-purge",
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

/**
 * Register the autocomplete prefix rebuild (every 10 minutes, §4.16).
 * @param {number} [intervalMs]
 */
export function scheduleSearchSuggestRecompute(intervalMs = SEARCH_SUGGEST_REBUILD_MS) {
  return getMaintenanceQueue().add(
    MaintenanceJob.SEARCH_SUGGEST_RECOMPUTE,
    {},
    {
      repeat: { every: intervalMs },
      jobId: "search-suggest-recompute",
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

/**
 * Register the daily Sticker-of-the-Day pick (00:05 UTC, §4.15).
 * @param {string} [cron]
 */
export function scheduleSotdPick(cron = SOTD_CRON) {
  return getMaintenanceQueue().add(
    MaintenanceJob.SOTD_PICK,
    {},
    {
      repeat: { pattern: cron },
      jobId: "sotd-pick",
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

export async function closeMaintenanceQueue() {
  if (!queue) return;
  const q = queue;
  queue = null;
  await q.close();
}
