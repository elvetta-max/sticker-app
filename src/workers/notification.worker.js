import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { redisConnectionOptions } from "../queues/connection.js";
import { NOTIFICATION_QUEUE_NAME, NotificationJob } from "../queues/notification.queue.js";
import {
  FCM_BATCH_SIZE,
  NOTIFICATION_LOG_TYPE,
  NOTIFICATION_LOG_TYPE_SEARCH_MATCH,
  SEARCH_MATCH_WINDOW_HOURS,
  utcDay,
} from "../lib/notification.js";
import { normalizeKeyword } from "../lib/normalize.js";
import { trendingSearchKey } from "../lib/search.js";

/**
 * Dispatch a manual broadcast campaign (context.md §4.11).
 *
 * Runs entirely in the worker: loads the targeted devices, atomically claims each
 * one for the day via `NotificationLog` (which enforces the global 1/day/device cap
 * even across parallel workers/retries), sends via the injected FCM sender in
 * batches of 500, releases the claim for transient failures so a retry can re-send,
 * and nulls out tokens FCM reports as dead.
 *
 * @param {{ prisma: any, sender: { sendBatch: Function }, data: {
 *   campaign_id: string, app_id: string, title: string, body: string,
 *   data?: object | null, device_ids: string[],
 * } }} args
 */
export async function dispatchBroadcast({ prisma, sender, data }) {
  const { campaign_id, app_id, title, body, device_ids = [] } = data;
  const payload = data.data ?? null;
  const day = utcDay();

  const summary = {
    campaign_id,
    targeted: device_ids.length,
    eligible: 0,
    sent: 0,
    failed: 0,
    skipped_capped: 0,
    dead_tokens: 0,
  };

  if (device_ids.length === 0) return summary;

  const devices = await prisma.deviceProfile.findMany({
    where: {
      device_id: { in: device_ids },
      app_id,
      notifications_enabled: true,
      fcm_token: { not: null },
    },
    select: { device_id: true, fcm_token: true },
  });
  summary.eligible = devices.length;
  if (devices.length === 0) return summary;

  // Atomic per-device daily claim: insert one log row per device (client-generated
  // ids) and let the `(device_id, day)` unique key drop duplicates. Only the rows
  // we actually inserted are ours to send to — this is correct even under concurrency.
  const candidates = devices.map((device) => ({
    id: randomUUID(),
    app_id,
    device_id: device.device_id,
    type: NOTIFICATION_LOG_TYPE,
    day,
    status: "SENT",
  }));
  await prisma.notificationLog.createMany({ data: candidates, skipDuplicates: true });

  const inserted = await prisma.notificationLog.findMany({
    where: { id: { in: candidates.map((candidate) => candidate.id) } },
    select: { id: true, device_id: true },
  });
  const claimByDevice = new Map(inserted.map((row) => [row.device_id, row.id]));
  summary.skipped_capped = devices.length - claimByDevice.size;

  const claimed = devices.filter((device) => claimByDevice.has(device.device_id));
  const message = { title, body, data: payload };
  const releaseLogIds = [];
  const deadDeviceIds = [];
  const deadLogIds = [];

  for (let offset = 0; offset < claimed.length; offset += FCM_BATCH_SIZE) {
    const batch = claimed.slice(offset, offset + FCM_BATCH_SIZE);
    const tokens = batch.map((device) => device.fcm_token);

    let responses;
    try {
      ({ responses } = await sender.sendBatch(tokens, message));
    } catch {
      // Whole batch failed upstream: release every claim so a retry re-sends.
      for (const device of batch) {
        summary.failed += 1;
        releaseLogIds.push(claimByDevice.get(device.device_id));
      }
      continue;
    }

    batch.forEach((device, index) => {
      const response = responses[index] ?? { success: false };
      if (response.success) {
        summary.sent += 1;
        return;
      }
      summary.failed += 1;
      if (response.dead) {
        deadDeviceIds.push(device.device_id);
        deadLogIds.push(claimByDevice.get(device.device_id));
      } else {
        releaseLogIds.push(claimByDevice.get(device.device_id));
      }
    });
  }

  if (releaseLogIds.length > 0) {
    await prisma.notificationLog.deleteMany({ where: { id: { in: releaseLogIds } } });
  }
  if (deadLogIds.length > 0) {
    await prisma.notificationLog.updateMany({
      where: { id: { in: deadLogIds } },
      data: { status: "FAILED" },
    });
  }
  if (deadDeviceIds.length > 0) {
    await prisma.deviceProfile.updateMany({
      where: { device_id: { in: deadDeviceIds } },
      data: { fcm_token: null },
    });
    summary.dead_tokens = deadDeviceIds.length;
  }

  return summary;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Build the per-device push payload for a matched keyword. Every value in the FCM
 * `data` map must be a string.
 * @param {{ image_id: string, keyword: string }} args
 */
function searchMatchMessage({ image_id, keyword }) {
  return {
    title: `New stickers for "${keyword}"`,
    body: `Fresh "${keyword}" stickers just landed. Tap to see them.`,
    data: { type: NOTIFICATION_LOG_TYPE_SEARCH_MATCH, image_id, keyword },
  };
}

/**
 * Choose which matched keyword a device should be notified about (§4.11 Phase-3
 * decision: prefer trending, then the most recent search). Only keywords present in
 * the app's trending-search ZSET are ranked; if none are, the most recent search
 * wins. Ties are broken by recency.
 *
 * @param {{ keyword: string, created_at: Date }[]} deviceSearches newest first
 * @param {Map<string, number|null>} scoreByKeyword
 */
function pickKeyword(deviceSearches, scoreByKeyword) {
  const latestByKeyword = new Map();
  for (const search of deviceSearches) {
    if (!latestByKeyword.has(search.keyword))
      latestByKeyword.set(search.keyword, search.created_at);
  }

  let best = null;
  for (const [keyword, created_at] of latestByKeyword) {
    const score = scoreByKeyword.get(keyword) ?? null;
    if (best == null) {
      best = { keyword, score, created_at };
      continue;
    }
    if (score != null && (best.score == null || score > best.score)) {
      best = { keyword, score, created_at };
    } else if (score != null && best.score != null && score === best.score) {
      if (created_at > best.created_at) best = { keyword, score, created_at };
    } else if (score == null && best.score == null && created_at > best.created_at) {
      best = { keyword, score, created_at };
    }
  }
  return best?.keyword;
}

/**
 * Event-driven `SEARCH_MATCH` push (context.md §4.11, Phase-3 design). Runs when a
 * sticker is uploaded: devices that searched one of the sticker's tags in the last
 * 48h and have not checked in since that search get one push. The global
 * 1/day/device cap is enforced with the same atomic `NotificationLog` claim as the
 * broadcast dispatcher, and dead tokens are cleared.
 *
 * @param {{ prisma: any, sender: { sendBatch: Function }, redis?: any, data: {
 *   image_id: string, app_id: string,
 * } }} args
 */
export async function dispatchSearchMatch({ prisma, sender, redis, data }) {
  const { image_id, app_id } = data;
  const summary = {
    image_id,
    matched: 0,
    eligible: 0,
    sent: 0,
    failed: 0,
    skipped_capped: 0,
    dead_tokens: 0,
  };

  const image = await prisma.image.findFirst({
    where: { id: image_id, app_id, is_hidden: false },
    select: { id: true, tags: { select: { name: true } } },
  });
  if (!image) return summary;

  const keywords = [
    ...new Set((image.tags ?? []).map((tag) => normalizeKeyword(tag.name)).filter(Boolean)),
  ];
  if (keywords.length === 0) return summary;

  const since = new Date(Date.now() - SEARCH_MATCH_WINDOW_HOURS * HOUR_MS);
  const searches = await prisma.searchQuery.findMany({
    where: { app_id, created_at: { gte: since }, keyword: { in: keywords } },
    select: { device_id: true, keyword: true, created_at: true },
    orderBy: { created_at: "desc" },
  });
  if (searches.length === 0) return summary;

  const candidateIds = [...new Set(searches.map((search) => search.device_id))];
  summary.matched = candidateIds.length;

  const devices = await prisma.deviceProfile.findMany({
    where: {
      device_id: { in: candidateIds },
      app_id,
      notifications_enabled: true,
      fcm_token: { not: null },
    },
    select: { device_id: true, fcm_token: true, last_active_date: true },
  });

  const searchesByDevice = new Map();
  for (const search of searches) {
    if (!searchesByDevice.has(search.device_id)) searchesByDevice.set(search.device_id, []);
    searchesByDevice.get(search.device_id).push(search);
  }

  const scoreByKeyword = new Map();
  if (typeof redis?.zscore === "function") {
    await Promise.all(
      keywords.map(async (keyword) => {
        try {
          const score = await redis.zscore(trendingSearchKey(app_id), keyword);
          scoreByKeyword.set(keyword, score == null ? null : Number(score));
        } catch {
          scoreByKeyword.set(keyword, null);
        }
      }),
    );
  }

  const eligible = [];
  for (const device of devices) {
    const deviceSearches = searchesByDevice.get(device.device_id) ?? [];
    if (deviceSearches.length === 0) continue;
    const latest = deviceSearches[0];
    // Only devices that have not opened the app since searching are targeted.
    if (new Date(device.last_active_date) >= new Date(latest.created_at)) continue;
    eligible.push({ device, keyword: pickKeyword(deviceSearches, scoreByKeyword) });
  }
  summary.eligible = eligible.length;
  if (eligible.length === 0) return summary;

  // Atomic per-device daily claim — shared with broadcast campaigns so the global
  // 1/day/device cap holds across every notification type.
  const day = utcDay();
  const candidates = eligible.map(({ device, keyword }) => ({
    id: randomUUID(),
    app_id,
    device_id: device.device_id,
    type: NOTIFICATION_LOG_TYPE_SEARCH_MATCH,
    image_id,
    keyword,
    day,
    status: "SENT",
  }));
  await prisma.notificationLog.createMany({ data: candidates, skipDuplicates: true });

  const inserted = await prisma.notificationLog.findMany({
    where: { id: { in: candidates.map((candidate) => candidate.id) } },
    select: { id: true, device_id: true },
  });
  const claimByDevice = new Map(inserted.map((row) => [row.device_id, row.id]));
  summary.skipped_capped = eligible.length - claimByDevice.size;

  const claimed = eligible.filter(({ device }) => claimByDevice.has(device.device_id));
  const byKeyword = new Map();
  for (const entry of claimed) {
    if (!byKeyword.has(entry.keyword)) byKeyword.set(entry.keyword, []);
    byKeyword.get(entry.keyword).push(entry.device);
  }

  const releaseLogIds = [];
  const deadDeviceIds = [];
  const deadLogIds = [];

  for (const [keyword, recipients] of byKeyword) {
    const message = searchMatchMessage({ image_id, keyword });
    for (let offset = 0; offset < recipients.length; offset += FCM_BATCH_SIZE) {
      const batch = recipients.slice(offset, offset + FCM_BATCH_SIZE);
      const tokens = batch.map((device) => device.fcm_token);

      let responses;
      try {
        ({ responses } = await sender.sendBatch(tokens, message));
      } catch {
        for (const device of batch) {
          summary.failed += 1;
          releaseLogIds.push(claimByDevice.get(device.device_id));
        }
        continue;
      }

      batch.forEach((device, index) => {
        const response = responses[index] ?? { success: false };
        if (response.success) {
          summary.sent += 1;
          return;
        }
        summary.failed += 1;
        if (response.dead) {
          deadDeviceIds.push(device.device_id);
          deadLogIds.push(claimByDevice.get(device.device_id));
        } else {
          releaseLogIds.push(claimByDevice.get(device.device_id));
        }
      });
    }
  }

  if (releaseLogIds.length > 0) {
    await prisma.notificationLog.deleteMany({ where: { id: { in: releaseLogIds } } });
  }
  if (deadLogIds.length > 0) {
    await prisma.notificationLog.updateMany({
      where: { id: { in: deadLogIds } },
      data: { status: "FAILED" },
    });
  }
  if (deadDeviceIds.length > 0) {
    await prisma.deviceProfile.updateMany({
      where: { device_id: { in: deadDeviceIds } },
      data: { fcm_token: null },
    });
    summary.dead_tokens = deadDeviceIds.length;
  }

  return summary;
}

/**
 * Start the notification worker.
 * @param {{ prisma: any, sender: { sendBatch: Function }, connection?: object, concurrency?: number }} deps
 */
export function startNotificationWorker({ prisma, sender, redis, connection, concurrency = 2 }) {
  return new Worker(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      if (job.name === NotificationJob.BROADCAST) {
        return dispatchBroadcast({ prisma, sender, data: job.data });
      }
      if (job.name === NotificationJob.SEARCH_MATCH) {
        return dispatchSearchMatch({ prisma, sender, redis, data: job.data });
      }
      throw new Error(`Unknown notification job: ${job.name}`);
    },
    { connection: connection ?? redisConnectionOptions(), concurrency },
  );
}
