import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import * as notificationWorker from "../../src/workers/notification.worker.js";
import * as notificationLib from "../../src/lib/notification.js";
import * as notificationQueue from "../../src/queues/notification.queue.js";

const { dispatchSearchMatch } = notificationWorker;
const { FCM_BATCH_SIZE, utcDay } = notificationLib;

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours) => new Date(Date.now() - hours * HOUR_MS);

const APP_ID = "app-1";
const OTHER_APP_ID = "app-2";

/**
 * Minimal in-memory Prisma double for the `SEARCH_MATCH` dispatcher. It emulates the
 * exact queries the dispatcher is contracted to run (image + tags, recent searches,
 * device profile filters, and the `(device_id, day)` daily-cap unique key).
 */
function createFakePrisma({ image = null, searches = [], devices = [], existingLogs = [] } = {}) {
  const logs = existingLogs.map((row, index) => ({
    id: row.id ?? `pre-${index}`,
    app_id: row.app_id ?? APP_ID,
    type: row.type ?? "BROADCAST",
    day: row.day ?? utcDay(),
    status: row.status ?? "SENT",
    ...row,
  }));
  const releases = [];
  const statusUpdates = [];
  const tokenClears = [];

  return {
    logs,
    releases,
    statusUpdates,
    tokenClears,
    image: {
      async findFirst({ where }) {
        if (!image) return null;
        if (image.id !== where.id || image.app_id !== where.app_id) return null;
        if (where.is_hidden === false && image.is_hidden) return null;
        return {
          id: image.id,
          tags: (image.tags ?? []).map((name) => ({ name })),
        };
      },
    },
    searchQuery: {
      async findMany({ where }) {
        const keywords = new Set(where.keyword.in);
        return searches
          .filter((row) => row.app_id === where.app_id)
          .filter((row) => new Date(row.created_at) >= where.created_at.gte)
          .filter((row) => keywords.has(row.keyword))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .map((row) => ({
            device_id: row.device_id,
            keyword: row.keyword,
            created_at: new Date(row.created_at),
          }));
      },
    },
    deviceProfile: {
      async findMany({ where }) {
        const ids = new Set(where.device_id.in);
        return devices
          .filter((device) => ids.has(device.device_id))
          .filter((device) => device.app_id === where.app_id)
          .filter((device) => device.notifications_enabled !== false)
          .filter((device) => device.fcm_token != null)
          .map((device) => ({
            device_id: device.device_id,
            fcm_token: device.fcm_token,
            last_active_date: new Date(device.last_active_date),
          }));
      },
      async updateMany({ where, data }) {
        tokenClears.push({ device_ids: where.device_id.in, data });
        return { count: where.device_id.in.length };
      },
    },
    notificationLog: {
      async createMany({ data, skipDuplicates }) {
        let count = 0;
        for (const row of data) {
          const conflict = logs.some(
            (log) => log.device_id === row.device_id && log.day === row.day,
          );
          if (conflict) {
            if (!skipDuplicates) throw new Error("unique constraint (device_id, day)");
            continue;
          }
          logs.push({ ...row });
          count += 1;
        }
        return { count };
      },
      async findMany({ where }) {
        const ids = new Set(where.id.in);
        return logs
          .filter((log) => ids.has(log.id))
          .map((log) => ({ id: log.id, device_id: log.device_id }));
      },
      async deleteMany({ where }) {
        const ids = new Set(where.id.in);
        const before = logs.length;
        for (let index = logs.length - 1; index >= 0; index -= 1) {
          if (ids.has(logs[index].id)) releases.push(logs[index].id);
        }
        logs.splice(0, logs.length, ...logs.filter((log) => !ids.has(log.id)));
        return { count: before - logs.length };
      },
      async updateMany({ where, data }) {
        const ids = new Set(where.id.in);
        statusUpdates.push({ ids: [...ids], data });
        for (const log of logs) if (ids.has(log.id)) log.status = data.status;
        return { count: where.id.in.length };
      },
    },
  };
}

/** Captures `sendBatch` calls; `behavior(token)` returns an FCM-like response. */
function createSender(behavior = () => ({ success: true })) {
  const batches = [];
  return {
    batches,
    async sendBatch(tokens, message) {
      batches.push({ tokens: [...tokens], message });
      return { responses: tokens.map((token) => behavior(token, message)) };
    },
  };
}

function makeDevice(device_id, overrides = {}) {
  return {
    device_id,
    app_id: APP_ID,
    fcm_token: `tok-${device_id}`,
    notifications_enabled: true,
    last_active_date: hoursAgo(5),
    ...overrides,
  };
}

function makeSearch(device_id, keyword, createdAt, app_id = APP_ID) {
  return { device_id, keyword, created_at: createdAt, app_id };
}

const zeroSummary = (image_id) => ({
  image_id,
  matched: 0,
  eligible: 0,
  sent: 0,
  failed: 0,
  skipped_capped: 0,
  dead_tokens: 0,
});

describe("SEARCH_MATCH contract", () => {
  it("exposes the 48h window and the SEARCH_MATCH log type", () => {
    expect(notificationLib.SEARCH_MATCH_WINDOW_HOURS).toBe(48);
    expect(notificationLib.NOTIFICATION_LOG_TYPE_SEARCH_MATCH).toBe("SEARCH_MATCH");
  });

  it("exposes the notification queue job name", () => {
    expect(notificationQueue.NotificationJob.SEARCH_MATCH).toBe("notification:search-match");
  });

  it("exports the dispatcher", () => {
    expect(typeof dispatchSearchMatch).toBe("function");
  });
});

describe("dispatchSearchMatch — audience selection", () => {
  it("only pushes devices that have not checked in since their latest matching search", async () => {
    const imageId = randomUUID();
    const searches = [
      makeSearch("eligible", "cat", hoursAgo(2)),
      makeSearch("active", "cat", hoursAgo(3)),
      makeSearch("disabled", "cat", hoursAgo(2)),
      makeSearch("notoken", "cat", hoursAgo(2)),
      // Outside the 48h window.
      makeSearch("old", "cat", hoursAgo(49)),
      // Tag that is not on the image.
      makeSearch("othertag", "fish", hoursAgo(1)),
      // Same keyword, different tenant.
      makeSearch("othertenant", "cat", hoursAgo(1), OTHER_APP_ID),
    ];
    const devices = [
      makeDevice("eligible", { last_active_date: hoursAgo(5) }),
      makeDevice("active", { last_active_date: hoursAgo(1) }),
      makeDevice("disabled", { notifications_enabled: false }),
      makeDevice("notoken", { fcm_token: null }),
      makeDevice("old", { last_active_date: hoursAgo(60) }),
      makeDevice("othertag", { last_active_date: hoursAgo(5) }),
      makeDevice("othertenant", { app_id: OTHER_APP_ID, last_active_date: hoursAgo(5) }),
    ];
    const prisma = createFakePrisma({
      image: { id: imageId, app_id: APP_ID, is_hidden: false, tags: ["cat", "dog"] },
      searches,
      devices,
    });
    const sender = createSender();

    const summary = await dispatchSearchMatch({
      prisma,
      sender,
      data: { image_id: imageId, app_id: APP_ID },
    });

    expect(summary).toEqual({
      image_id: imageId,
      matched: 4,
      eligible: 1,
      sent: 1,
      failed: 0,
      skipped_capped: 0,
      dead_tokens: 0,
    });
    expect(sender.batches).toHaveLength(1);
    expect(sender.batches[0].tokens).toEqual(["tok-eligible"]);
    expect(sender.batches[0].message).toEqual({
      title: 'New stickers for "cat"',
      body: 'Fresh "cat" stickers just landed. Tap to see them.',
      data: { type: "SEARCH_MATCH", image_id: imageId, keyword: "cat" },
    });
    expect(prisma.logs.map((log) => log.device_id)).toEqual(["eligible"]);
  });
});

describe("dispatchSearchMatch — per-device keyword", () => {
  it("prefers the highest trending score, then the most recent search", async () => {
    const imageId = randomUUID();
    const searches = [
      // Trending winner: dog (9) beats cat (5).
      makeSearch("trending", "cat", hoursAgo(3)),
      makeSearch("trending", "dog", hoursAgo(1)),
      // Only one keyword, present in the trending ZSET.
      makeSearch("single", "cat", hoursAgo(2)),
    ];
    const devices = ["trending", "single"].map((id) => makeDevice(id));
    const prisma = createFakePrisma({
      image: { id: imageId, app_id: APP_ID, is_hidden: false, tags: ["cat", "dog"] },
      searches,
      devices,
    });
    const sender = createSender();
    const redis = {
      async zscore(_key, keyword) {
        if (keyword === "cat") return 5;
        if (keyword === "dog") return 9;
        return null;
      },
    };

    const summary = await dispatchSearchMatch({
      prisma,
      sender,
      redis,
      data: { image_id: imageId, app_id: APP_ID },
    });

    expect(summary).toMatchObject({ matched: 2, eligible: 2, sent: 2 });

    const byKeyword = Object.fromEntries(
      sender.batches.map((batch) => [batch.message.data.keyword, batch]),
    );
    expect(Object.keys(byKeyword).sort()).toEqual(["cat", "dog"]);
    expect(byKeyword.dog.tokens).toEqual(["tok-trending"]);
    expect(byKeyword.cat.tokens).toEqual(["tok-single"]);
    expect(byKeyword.dog.message).toEqual({
      title: 'New stickers for "dog"',
      body: 'Fresh "dog" stickers just landed. Tap to see them.',
      data: { type: "SEARCH_MATCH", image_id: imageId, keyword: "dog" },
    });
  });

  it("breaks equal trending scores using the most recent matching search", async () => {
    const imageId = randomUUID();
    const prisma = createFakePrisma({
      image: { id: imageId, app_id: APP_ID, is_hidden: false, tags: ["cat", "dog"] },
      searches: [makeSearch("tie", "cat", hoursAgo(2)), makeSearch("tie", "dog", hoursAgo(1))],
      devices: [makeDevice("tie")],
    });
    const sender = createSender();
    const redis = {
      async zscore() {
        return 5;
      },
    };

    const summary = await dispatchSearchMatch({
      prisma,
      sender,
      redis,
      data: { image_id: imageId, app_id: APP_ID },
    });

    expect(summary.sent).toBe(1);
    expect(sender.batches[0].message.data.keyword).toBe("dog");
  });

  it("falls back to the most recent search when no keyword is in the trending ZSET", async () => {
    const imageId = randomUUID();
    const prisma = createFakePrisma({
      image: { id: imageId, app_id: APP_ID, is_hidden: false, tags: ["cat", "dog"] },
      searches: [makeSearch("dev", "dog", hoursAgo(2)), makeSearch("dev", "cat", hoursAgo(1))],
      devices: [makeDevice("dev")],
    });
    const sender = createSender();
    const redis = {
      async zscore() {
        return null;
      },
    };

    const summary = await dispatchSearchMatch({
      prisma,
      sender,
      redis,
      data: { image_id: imageId, app_id: APP_ID },
    });

    expect(summary.sent).toBe(1);
    expect(sender.batches[0].message.data.keyword).toBe("cat");
  });

  it("uses the most recent search when Redis is not injected", async () => {
    const imageId = randomUUID();
    const prisma = createFakePrisma({
      image: { id: imageId, app_id: APP_ID, is_hidden: false, tags: ["cat", "dog"] },
      searches: [makeSearch("dev", "dog", hoursAgo(2)), makeSearch("dev", "cat", hoursAgo(1))],
      devices: [makeDevice("dev")],
    });
    const sender = createSender();

    const summary = await dispatchSearchMatch({
      prisma,
      sender,
      data: { image_id: imageId, app_id: APP_ID },
    });

    expect(summary.sent).toBe(1);
    expect(sender.batches[0].message.data.keyword).toBe("cat");
  });
});

describe("dispatchSearchMatch — batching and daily cap", () => {
  it("splits a single message group at the 500-recipient FCM limit", async () => {
    const imageId = randomUUID();
    const count = FCM_BATCH_SIZE + 1;
    const devices = Array.from({ length: count }, (_, index) =>
      makeDevice(`bulk-${index}`, { last_active_date: hoursAgo(5) }),
    );
    const searches = devices.map((device) => makeSearch(device.device_id, "cat", hoursAgo(1)));
    const prisma = createFakePrisma({
      image: { id: imageId, app_id: APP_ID, is_hidden: false, tags: ["cat"] },
      searches,
      devices,
    });
    const sender = createSender();

    const summary = await dispatchSearchMatch({
      prisma,
      sender,
      data: { image_id: imageId, app_id: APP_ID },
    });

    expect(summary).toEqual({
      image_id: imageId,
      matched: count,
      eligible: count,
      sent: count,
      failed: 0,
      skipped_capped: 0,
      dead_tokens: 0,
    });
    expect(sender.batches.map((batch) => batch.tokens.length)).toEqual([500, 1]);
    expect(sender.batches.every((batch) => batch.message.data.keyword === "cat")).toBe(true);
  });

  it("skips a device already notified today via the global 1/day/device cap", async () => {
    const imageId = randomUUID();
    const prisma = createFakePrisma({
      image: { id: imageId, app_id: APP_ID, is_hidden: false, tags: ["cat"] },
      searches: [makeSearch("capped", "cat", hoursAgo(1)), makeSearch("fresh", "cat", hoursAgo(1))],
      devices: [makeDevice("capped"), makeDevice("fresh")],
      existingLogs: [{ device_id: "capped", day: utcDay(), type: "BROADCAST", status: "SENT" }],
    });
    const sender = createSender();

    const summary = await dispatchSearchMatch({
      prisma,
      sender,
      data: { image_id: imageId, app_id: APP_ID },
    });

    expect(summary).toMatchObject({ eligible: 2, sent: 1, skipped_capped: 1, failed: 0 });
    expect(sender.batches).toHaveLength(1);
    expect(sender.batches[0].tokens).toEqual(["tok-fresh"]);
    expect(prisma.logs.map((log) => log.device_id).sort()).toEqual(["capped", "fresh"]);
  });
});

describe("dispatchSearchMatch — FCM failures", () => {
  it("clears a dead token and marks its claim FAILED", async () => {
    const imageId = randomUUID();
    const prisma = createFakePrisma({
      image: { id: imageId, app_id: APP_ID, is_hidden: false, tags: ["cat"] },
      searches: [makeSearch("ok", "cat", hoursAgo(1)), makeSearch("dead", "cat", hoursAgo(1))],
      devices: [makeDevice("ok"), makeDevice("dead")],
    });
    const sender = createSender((token) =>
      token === "tok-dead" ? { success: false, dead: true } : { success: true },
    );

    const summary = await dispatchSearchMatch({
      prisma,
      sender,
      data: { image_id: imageId, app_id: APP_ID },
    });

    expect(summary).toMatchObject({ sent: 1, failed: 1, dead_tokens: 1 });
    expect(prisma.tokenClears).toHaveLength(1);
    expect(prisma.tokenClears[0].device_ids).toEqual(["dead"]);
    expect(prisma.tokenClears[0].data).toEqual({ fcm_token: null });
    expect(prisma.releases).toHaveLength(0);
    expect(prisma.logs.find((log) => log.device_id === "dead").status).toBe("FAILED");
    expect(prisma.logs.find((log) => log.device_id === "ok").status).toBe("SENT");
  });

  it("releases the claim when a whole batch throws so a retry can re-send", async () => {
    const imageId = randomUUID();
    const prisma = createFakePrisma({
      image: { id: imageId, app_id: APP_ID, is_hidden: false, tags: ["cat"] },
      searches: [makeSearch("dev", "cat", hoursAgo(1))],
      devices: [makeDevice("dev")],
    });
    const sender = {
      async sendBatch() {
        throw new Error("fcm down");
      },
    };

    const summary = await dispatchSearchMatch({
      prisma,
      sender,
      data: { image_id: imageId, app_id: APP_ID },
    });

    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    expect(prisma.releases).toHaveLength(1);
    expect(prisma.logs).toHaveLength(0);
  });
});

describe("dispatchSearchMatch — no-op paths", () => {
  const cases = [
    ["a hidden image", { is_hidden: true, tags: ["cat"] }],
    ["an unknown image", null],
    ["an image with no tags", { is_hidden: false, tags: [] }],
    ["an image whose tags normalize to empty", { is_hidden: false, tags: ["!!!", "   "] }],
  ];

  for (const [label, imageSpec] of cases) {
    it(`returns a zero summary and sends nothing for ${label}`, async () => {
      const imageId = randomUUID();
      const image = imageSpec ? { id: imageId, app_id: APP_ID, ...imageSpec } : null;
      const prisma = createFakePrisma({
        image,
        searches: [makeSearch("dev", "cat", hoursAgo(1))],
        devices: [makeDevice("dev")],
      });
      const sender = createSender();

      const summary = await dispatchSearchMatch({
        prisma,
        sender,
        data: { image_id: imageId, app_id: APP_ID },
      });

      expect(summary).toEqual(zeroSummary(imageId));
      expect(sender.batches).toHaveLength(0);
      expect(prisma.logs).toHaveLength(0);
    });
  }
});
