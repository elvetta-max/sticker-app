import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { signAccessToken } from "../../src/lib/tokens.js";
import { buildZip } from "../fixtures/zip-builder.js";

/** In-memory Redis double: rate limiter (INCR/EXPIRE) + cache (GET/SET/SCAN/DEL). */
function createFakeRedis() {
  const kv = new Map();
  const counts = new Map();
  return {
    async ping() {
      return "PONG";
    },
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async set(key, value) {
      kv.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return "OK";
    },
    async incr(key) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys) if (kv.delete(key)) removed += 1;
      return removed;
    },
    async scan(_cursor, _match, pattern) {
      const regex = new RegExp(
        `^${String(pattern)
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")}$`,
      );
      return ["0", [...kv.keys()].filter((key) => regex.test(key))];
    },
  };
}

/** Captures sticker-upload/replace/delete jobs and returns deterministic ids. */
function createStickerQueue() {
  const added = [];
  return {
    added,
    async add(name, data) {
      const job = { id: `audit-job-${added.length + 1}`, name, data };
      added.push(job);
      return job;
    },
  };
}

/** Captures broadcast campaigns (campaign_id is also the BullMQ job id). */
function createNotificationQueue() {
  const jobs = new Map();
  return {
    jobs,
    async add(name, data, opts) {
      const job = { id: opts.jobId, name, data, opts };
      jobs.set(opts.jobId, job);
      return job;
    },
    async getJob(id) {
      if (!jobs.has(id)) return null;
      return {
        id,
        getState: async () => "completed",
        returnvalue: { sent: 0, failed: 0 },
        failedReason: null,
      };
    },
  };
}

/** Captures the bulk flow tree and returns the parent job id. */
function createFlowProducer() {
  const trees = [];
  return {
    trees,
    async add(tree) {
      trees.push(tree);
      return { job: { id: tree.opts.jobId }, children: [] };
    },
  };
}

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const USERNAME = `audit-admin-${suffix}`;
const OTHER_ADMIN_ID = `other-admin-${suffix}`;

let app;
let prisma;
let admin;
let token;
let png;

let stickerAppId;
let reportAppId;
let notifyAppId;
let versionAppId;
let adsAppId;
let maintenanceAppId;
let listAppId;
const appIds = [];

beforeAll(async () => {
  prisma = getPrisma();

  admin = await prisma.admin.create({
    data: { username: USERNAME, password: "x".repeat(60) },
  });
  token = signAccessToken({ id: admin.id, username: USERNAME });

  stickerAppId = randomUUID();
  reportAppId = randomUUID();
  notifyAppId = randomUUID();
  versionAppId = randomUUID();
  adsAppId = randomUUID();
  maintenanceAppId = randomUUID();
  listAppId = randomUUID();
  appIds.push(
    stickerAppId,
    reportAppId,
    notifyAppId,
    versionAppId,
    adsAppId,
    maintenanceAppId,
    listAppId,
  );

  for (const [id, name] of [
    [stickerAppId, "stickers"],
    [reportAppId, "reports"],
    [notifyAppId, "notifications"],
    [versionAppId, "version"],
    [adsAppId, "ads"],
    [maintenanceAppId, "maintenance"],
    [listAppId, "list"],
  ]) {
    await prisma.app.create({
      data: {
        id,
        name: `Audit ${name}`,
        package_name: `test.audit.${name}.${suffix}`,
      },
    });
  }

  png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .png()
    .toBuffer();

  app = createApp({
    prisma,
    redis: createFakeRedis(),
    stickerQueue: createStickerQueue(),
    notificationQueue: createNotificationQueue(),
    flowProducer: createFlowProducer(),
  });
});

afterAll(async () => {
  if (prisma.auditLog) {
    await prisma.auditLog.deleteMany({
      where: { OR: [{ app_id: { in: appIds } }, { admin_id: admin.id }] },
    });
  }
  await prisma.report.deleteMany({ where: { app_id: { in: appIds } } });
  await prisma.image.deleteMany({ where: { app_id: { in: appIds } } });
  await prisma.app.deleteMany({ where: { id: { in: appIds } } });
  await prisma.admin.deleteMany({ where: { username: USERNAME } });
  await disconnectPrisma();
});

const auth = (req) => req.set("Authorization", `Bearer ${token}`);

async function createImage(app_id, name) {
  return prisma.image.create({
    data: {
      app_id,
      image_url: `https://cdn.test/${suffix}/${name}.webp`,
      cloudinary_public_id: `test/${suffix}/${name}`,
    },
  });
}

/**
 * Assert exactly one audit row exists for this action/target and that it carries
 * the authenticated admin and tenant. Duplicated writes fail the test.
 */
async function expectSingleAudit({ action, target_type, target_id, app_id }) {
  const rows = await prisma.auditLog.findMany({ where: { action, target_id, app_id } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action,
    target_type,
    target_id,
    app_id,
    admin_id: admin.id,
    admin_username: USERNAME,
  });
  return rows[0];
}

describe("admin sticker mutations write audit rows", () => {
  it("records sticker.create for a queued upload (target = job id)", async () => {
    const res = await auth(request(app).post("/api/admin/stickers"))
      .field("app_id", stickerAppId)
      .attach("image", png, { filename: "create.png", contentType: "image/png" });

    expect(res.status).toBe(202);
    await expectSingleAudit({
      action: "sticker.create",
      target_type: "job",
      target_id: res.body.job_id,
      app_id: stickerAppId,
    });
  });

  it("records sticker.update for a metadata-only update", async () => {
    const sticker = await createImage(stickerAppId, "update");

    const res = await auth(request(app).put(`/api/admin/stickers/${sticker.id}`)).send({
      is_premium: true,
    });

    expect(res.status).toBe(200);
    await expectSingleAudit({
      action: "sticker.update",
      target_type: "sticker",
      target_id: sticker.id,
      app_id: stickerAppId,
    });
  });

  it("records sticker.replace when a new image is queued", async () => {
    const sticker = await createImage(stickerAppId, "replace");

    const res = await auth(request(app).put(`/api/admin/stickers/${sticker.id}`)).attach(
      "image",
      png,
      { filename: "replace.png", contentType: "image/png" },
    );

    expect(res.status).toBe(202);
    await expectSingleAudit({
      action: "sticker.replace",
      target_type: "sticker",
      target_id: sticker.id,
      app_id: stickerAppId,
    });
  });

  it("records sticker.delete with the sticker's tenant", async () => {
    const sticker = await createImage(stickerAppId, "delete");

    const res = await auth(request(app).delete(`/api/admin/stickers/${sticker.id}`));

    expect(res.status).toBe(200);
    await expectSingleAudit({
      action: "sticker.delete",
      target_type: "sticker",
      target_id: sticker.id,
      app_id: stickerAppId,
    });
  });

  it("records sticker.hide and sticker.unhide", async () => {
    const sticker = await createImage(stickerAppId, "hide");

    const hidden = await auth(request(app).post(`/api/admin/stickers/${sticker.id}/hide`));
    expect(hidden.status).toBe(200);
    await expectSingleAudit({
      action: "sticker.hide",
      target_type: "sticker",
      target_id: sticker.id,
      app_id: stickerAppId,
    });

    const restored = await auth(request(app).post(`/api/admin/stickers/${sticker.id}/unhide`));
    expect(restored.status).toBe(200);
    await expectSingleAudit({
      action: "sticker.unhide",
      target_type: "sticker",
      target_id: sticker.id,
      app_id: stickerAppId,
    });
  });

  it("records sticker.bulk for a queued ZIP (target = job id)", async () => {
    const zip = buildZip([{ name: "set/a.png", data: png }]);

    const res = await auth(request(app).post("/api/admin/stickers/bulk"))
      .field("app_id", stickerAppId)
      .attach("zip", zip, { filename: "stickers.zip", contentType: "application/zip" });

    expect(res.status).toBe(202);
    await expectSingleAudit({
      action: "sticker.bulk",
      target_type: "job",
      target_id: res.body.job_id,
      app_id: stickerAppId,
    });
  });

  it("does not write an audit row for a failed (404) mutation", async () => {
    const unknownId = randomUUID();

    const res = await auth(request(app).delete(`/api/admin/stickers/${unknownId}`));
    expect(res.status).toBe(404);

    const rows = await prisma.auditLog.findMany({
      where: { action: "sticker.delete", target_id: unknownId },
    });
    expect(rows).toHaveLength(0);
  });
});

describe("admin app mutations write audit rows", () => {
  it("records app.version.update", async () => {
    const res = await auth(request(app).put(`/api/admin/apps/${versionAppId}/version`)).send({
      target_version: 3,
      force_update: true,
    });

    expect(res.status).toBe(200);
    await expectSingleAudit({
      action: "app.version.update",
      target_type: "app",
      target_id: versionAppId,
      app_id: versionAppId,
    });
  });

  it("records app.ads.update", async () => {
    const res = await auth(request(app).put(`/api/admin/apps/${adsAppId}/ads`)).send({
      admob_banner: "ca-app-pub-1234567890123456/1234567890",
    });

    expect(res.status).toBe(200);
    await expectSingleAudit({
      action: "app.ads.update",
      target_type: "app",
      target_id: adsAppId,
      app_id: adsAppId,
    });
  });

  it("records app.maintenance.update", async () => {
    const res = await auth(
      request(app).put(`/api/admin/apps/${maintenanceAppId}/maintenance`),
    ).send({ maintenance_mode: true });

    expect(res.status).toBe(200);
    await expectSingleAudit({
      action: "app.maintenance.update",
      target_type: "app",
      target_id: maintenanceAppId,
      app_id: maintenanceAppId,
    });
  });
});

describe("admin moderation mutations write audit rows", () => {
  it("records report.dismiss and report.resolve with the report's tenant", async () => {
    const image = await createImage(reportAppId, "report");

    const dismissedReport = await prisma.report.create({
      data: {
        app_id: reportAppId,
        device_id: `dismiss-${suffix}`,
        image_id: image.id,
        reason: "spam",
      },
    });
    const resolvedReport = await prisma.report.create({
      data: {
        app_id: reportAppId,
        device_id: `resolve-${suffix}`,
        image_id: image.id,
        reason: "copyright",
      },
    });

    const dismissed = await auth(
      request(app).post(`/api/admin/reports/${dismissedReport.id}/dismiss`),
    );
    expect(dismissed.status).toBe(200);
    await expectSingleAudit({
      action: "report.dismiss",
      target_type: "report",
      target_id: dismissedReport.id,
      app_id: reportAppId,
    });

    const resolved = await auth(
      request(app).post(`/api/admin/reports/${resolvedReport.id}/resolve`),
    );
    expect(resolved.status).toBe(200);
    await expectSingleAudit({
      action: "report.resolve",
      target_type: "report",
      target_id: resolvedReport.id,
      app_id: reportAppId,
    });
  });
});

describe("admin notification mutations write audit rows", () => {
  it("records notification.broadcast with the campaign id as target", async () => {
    const res = await auth(request(app).post("/api/admin/notifications/broadcast")).send({
      app_id: notifyAppId,
      target_type: "ALL",
      title: "Audit test",
      body: "Audit test body",
    });

    expect(res.status).toBe(202);
    await expectSingleAudit({
      action: "notification.broadcast",
      target_type: "notification",
      target_id: res.body.campaign_id,
      app_id: notifyAppId,
    });
  });
});

describe("GET /api/admin/audit", () => {
  /**
   * Seed exactly three deterministic rows for the listing tenant. Re-running it per
   * test keeps pagination assertions independent of pre-existing audit history.
   */
  async function seedRows() {
    await prisma.auditLog.deleteMany({ where: { app_id: listAppId } });
    const base = Date.now();

    const oldest = await prisma.auditLog.create({
      data: {
        admin_id: admin.id,
        admin_username: USERNAME,
        action: "sticker.create",
        target_type: "job",
        target_id: `job-${suffix}-1`,
        app_id: listAppId,
        metadata: { source: "list-1" },
        created_at: new Date(base - 3 * 60 * 1000),
      },
    });
    const middle = await prisma.auditLog.create({
      data: {
        admin_id: admin.id,
        admin_username: USERNAME,
        action: "sticker.update",
        target_type: "sticker",
        target_id: `sticker-${suffix}-2`,
        app_id: listAppId,
        created_at: new Date(base - 2 * 60 * 1000),
      },
    });
    const newest = await prisma.auditLog.create({
      data: {
        admin_id: OTHER_ADMIN_ID,
        admin_username: "other-admin",
        action: "sticker.delete",
        target_type: "sticker",
        target_id: `sticker-${suffix}-3`,
        app_id: listAppId,
        metadata: { source: "list-3" },
        created_at: new Date(base - 1 * 60 * 1000),
      },
    });

    return { oldest, middle, newest };
  }

  it("lists rows newest-first with the documented DTO shape", async () => {
    const rows = await seedRows();
    const res = await auth(request(app).get(`/api/admin/audit?app_id=${listAppId}`));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.next_cursor).toBeNull();
    expect(res.body.data.map((row) => row.id)).toEqual([
      rows.newest.id,
      rows.middle.id,
      rows.oldest.id,
    ]);

    const newest = res.body.data[0];
    expect(Object.keys(newest).sort()).toEqual([
      "action",
      "admin_id",
      "admin_username",
      "app_id",
      "created_at",
      "id",
      "metadata",
      "target_id",
      "target_type",
    ]);
    expect(newest).toMatchObject({
      id: rows.newest.id,
      admin_id: OTHER_ADMIN_ID,
      admin_username: "other-admin",
      action: "sticker.delete",
      target_type: "sticker",
      target_id: `sticker-${suffix}-3`,
      app_id: listAppId,
      metadata: { source: "list-3" },
    });
    expect(newest.created_at).toBe(rows.newest.created_at.toISOString());
    expect(res.body.data[1].metadata).toBeNull();
  });

  it("filters by action, app_id and admin_id with AND semantics", async () => {
    const rows = await seedRows();

    const byAction = await auth(
      request(app).get(`/api/admin/audit?app_id=${listAppId}&action=sticker.update`),
    );
    expect(byAction.status).toBe(200);
    expect(byAction.body.data.map((row) => row.id)).toEqual([rows.middle.id]);

    const byAdmin = await auth(
      request(app).get(`/api/admin/audit?app_id=${listAppId}&admin_id=${admin.id}`),
    );
    expect(byAdmin.body.data.map((row) => row.id)).toEqual([rows.middle.id, rows.oldest.id]);

    const combined = await auth(
      request(app).get(
        `/api/admin/audit?app_id=${listAppId}&action=sticker.update&admin_id=${admin.id}`,
      ),
    );
    expect(combined.body.data.map((row) => row.id)).toEqual([rows.middle.id]);

    const noMatch = await auth(
      request(app).get(
        `/api/admin/audit?app_id=${listAppId}&action=sticker.update&admin_id=${OTHER_ADMIN_ID}`,
      ),
    );
    expect(noMatch.body.data).toEqual([]);
  });

  it("paginates newest-first with a keyset cursor", async () => {
    const rows = await seedRows();

    const first = await auth(request(app).get(`/api/admin/audit?app_id=${listAppId}&limit=1`));
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.data[0].id).toBe(rows.newest.id);
    expect(first.body.next_cursor).toBeTruthy();

    const second = await auth(
      request(app).get(
        `/api/admin/audit?app_id=${listAppId}&limit=1&cursor=${first.body.next_cursor}`,
      ),
    );
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).toBe(rows.middle.id);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(second.body.next_cursor).toBeTruthy();

    const third = await auth(
      request(app).get(
        `/api/admin/audit?app_id=${listAppId}&limit=1&cursor=${second.body.next_cursor}`,
      ),
    );
    expect(third.body.data).toHaveLength(1);
    expect(third.body.data[0].id).toBe(rows.oldest.id);
    expect(third.body.next_cursor).toBeNull();
  });

  it("ignores unknown extra query params", async () => {
    await seedRows();
    const res = await auth(request(app).get(`/api/admin/audit?app_id=${listAppId}&unknown=value`));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it("returns 400 VALIDATION_ERROR for an invalid cursor", async () => {
    const res = await auth(request(app).get(`/api/admin/audit?app_id=${listAppId}&cursor=!!!!`));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("validates the query", async () => {
    const cases = [
      "app_id=not-a-uuid",
      `app_id=${listAppId}&action=`,
      `app_id=${listAppId}&action=${"a".repeat(65)}`,
      `app_id=${listAppId}&admin_id=`,
      `app_id=${listAppId}&limit=0`,
      `app_id=${listAppId}&limit=101`,
      `app_id=${listAppId}&limit=abc`,
    ];

    for (const query of cases) {
      const res = await auth(request(app).get(`/api/admin/audit?${query}`));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }

    const capped = await auth(request(app).get(`/api/admin/audit?app_id=${listAppId}&limit=100`));
    expect(capped.status).toBe(200);
  });

  it("requires admin auth", async () => {
    const res = await request(app).get(`/api/admin/audit?app_id=${listAppId}`);
    expect(res.status).toBe(401);
  });

  it("is append-only: PUT/DELETE/PATCH have no route", async () => {
    for (const method of ["put", "delete", "patch"]) {
      const res = await auth(request(app)[method]("/api/admin/audit"));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
  });
});
