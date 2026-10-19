import { describe, it, expect } from "vitest";
import { dispatchBroadcast } from "../../src/workers/notification.worker.js";
import { FCM_BATCH_SIZE, utcDay } from "../../src/lib/notification.js";

/**
 * Fake prisma that emulates the daily unique key `(device_id, day)` and records
 * the side effects the worker performs (claims, releases, status changes, token clears).
 */
function makePrisma({ devices = [], existingLogDeviceIds = [] } = {}) {
  const logs = existingLogDeviceIds.map((device_id) => ({
    id: `pre-${device_id}`,
    device_id,
    day: utcDay(),
    status: "SENT",
  }));
  const releases = [];
  const statusUpdates = [];
  const tokenClears = [];

  return {
    logs,
    releases,
    statusUpdates,
    tokenClears,
    deviceProfile: {
      async findMany() {
        return devices;
      },
      async updateMany({ where, data }) {
        tokenClears.push({ device_ids: where.device_id.in, data });
        return { count: where.device_id.in.length };
      },
    },
    notificationLog: {
      async createMany({ data }) {
        let count = 0;
        for (const row of data) {
          const conflict = logs.some(
            (log) => log.device_id === row.device_id && log.day === row.day,
          );
          if (!conflict) {
            logs.push(row);
            count += 1;
          }
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
        for (let i = logs.length - 1; i >= 0; i -= 1) {
          if (ids.has(logs[i].id)) releases.push(logs[i].id);
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

function makeSender(behavior) {
  const batches = [];
  return {
    batches,
    async sendBatch(tokens, message) {
      batches.push({ tokens, message });
      return { responses: behavior(tokens) };
    },
  };
}

const devicesFrom = (specs, app_id = "app-1") =>
  specs.map((spec) => ({ device_id: spec.id, fcm_token: spec.token, app_id }));

describe("dispatchBroadcast", () => {
  it("batches at the FCM multicast limit and claims each device once", async () => {
    const specs = Array.from({ length: FCM_BATCH_SIZE + 1 }, (_, i) => ({
      id: `dev-${i}`,
      token: `tok-${i}`,
    }));
    const prisma = makePrisma({ devices: devicesFrom(specs) });
    const sender = makeSender((tokens) => tokens.map(() => ({ success: true })));

    const summary = await dispatchBroadcast({
      prisma,
      sender,
      data: {
        campaign_id: "c1",
        app_id: "app-1",
        title: "Hi",
        body: "There",
        device_ids: specs.map((s) => s.id),
      },
    });

    expect(sender.batches.map((batch) => batch.tokens.length)).toEqual([500, 1]);
    expect(sender.batches[0].message).toEqual({ title: "Hi", body: "There", data: null });
    expect(summary.sent).toBe(FCM_BATCH_SIZE + 1);
    expect(prisma.logs).toHaveLength(FCM_BATCH_SIZE + 1);
  });

  it("enforces the global 1/day/device cap via the atomic claim", async () => {
    const specs = [
      { id: "fresh", token: "t-fresh" },
      { id: "capped", token: "t-capped" },
    ];
    const prisma = makePrisma({ devices: devicesFrom(specs), existingLogDeviceIds: ["capped"] });
    const sender = makeSender((tokens) => tokens.map(() => ({ success: true })));

    const summary = await dispatchBroadcast({
      prisma,
      sender,
      data: {
        campaign_id: "c2",
        app_id: "app-1",
        title: "Hi",
        body: "There",
        device_ids: ["fresh", "capped"],
      },
    });

    expect(summary).toMatchObject({ eligible: 2, sent: 1, skipped_capped: 1 });
    expect(sender.batches).toHaveLength(1);
    expect(sender.batches[0].tokens).toEqual(["t-fresh"]);
    expect(prisma.logs.map((row) => row.device_id)).toEqual(["capped", "fresh"]);
  });

  it("clears dead tokens and keeps their claim (status FAILED)", async () => {
    const specs = [
      { id: "ok", token: "t-ok" },
      { id: "dead", token: "t-dead" },
    ];
    const prisma = makePrisma({ devices: devicesFrom(specs) });
    const sender = makeSender((tokens) =>
      tokens.map((token) =>
        token === "t-dead" ? { success: false, dead: true } : { success: true },
      ),
    );

    const summary = await dispatchBroadcast({
      prisma,
      sender,
      data: {
        campaign_id: "c3",
        app_id: "app-1",
        title: "Hi",
        body: "There",
        device_ids: ["ok", "dead"],
      },
    });

    expect(summary).toMatchObject({ sent: 1, failed: 1, dead_tokens: 1 });
    expect(prisma.tokenClears).toEqual([{ device_ids: ["dead"], data: { fcm_token: null } }]);
    expect(prisma.releases).toHaveLength(0);
    const deadLog = prisma.logs.find((log) => log.device_id === "dead");
    expect(deadLog.status).toBe("FAILED");
  });

  it("releases claims for a whole failed batch so a retry re-sends", async () => {
    const specs = [{ id: "a", token: "t-a" }];
    const prisma = makePrisma({ devices: devicesFrom(specs) });
    const sender = {
      async sendBatch() {
        throw new Error("fcm down");
      },
    };

    const summary = await dispatchBroadcast({
      prisma,
      sender,
      data: {
        campaign_id: "c4",
        app_id: "app-1",
        title: "Hi",
        body: "There",
        device_ids: ["a"],
      },
    });

    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    expect(prisma.logs).toHaveLength(0);
    expect(prisma.releases).toHaveLength(1);
  });

  it("is a no-op for an empty audience", async () => {
    const prisma = makePrisma();
    const sender = makeSender(() => []);
    const summary = await dispatchBroadcast({
      prisma,
      sender,
      data: { campaign_id: "c5", app_id: "app-1", title: "Hi", body: "There", device_ids: [] },
    });
    expect(summary).toMatchObject({ targeted: 0, sent: 0, failed: 0 });
    expect(sender.batches).toHaveLength(0);
  });
});
