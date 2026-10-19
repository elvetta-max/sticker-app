import { describe, it, expect, vi } from "vitest";
import { AuditAction, AuditTarget, recordAudit } from "../../src/lib/audit.js";

const EXPECTED_ACTIONS = {
  STICKER_CREATE: "sticker.create",
  STICKER_UPDATE: "sticker.update",
  STICKER_REPLACE: "sticker.replace",
  STICKER_DELETE: "sticker.delete",
  STICKER_HIDE: "sticker.hide",
  STICKER_UNHIDE: "sticker.unhide",
  STICKER_BULK: "sticker.bulk",
  APP_VERSION_UPDATE: "app.version.update",
  APP_ADS_UPDATE: "app.ads.update",
  APP_MAINTENANCE_UPDATE: "app.maintenance.update",
  REPORT_DISMISS: "report.dismiss",
  REPORT_RESOLVE: "report.resolve",
  NOTIFICATION_BROADCAST: "notification.broadcast",
};

const EXPECTED_TARGETS = {
  STICKER: "sticker",
  JOB: "job",
  APP: "app",
  REPORT: "report",
  NOTIFICATION: "notification",
};

/** Build the minimal Prisma double needed by recordAudit. */
function createPrisma(create = vi.fn()) {
  return { auditLog: { create } };
}

describe("audit constants", () => {
  it("exposes exactly the documented action constants and is frozen", () => {
    expect(AuditAction).toEqual(EXPECTED_ACTIONS);
    expect(Object.keys(AuditAction).sort()).toEqual(Object.keys(EXPECTED_ACTIONS).sort());
    expect(Object.isFrozen(AuditAction)).toBe(true);
  });

  it("exposes exactly the documented target constants and is frozen", () => {
    expect(AuditTarget).toEqual(EXPECTED_TARGETS);
    expect(Object.keys(AuditTarget).sort()).toEqual(Object.keys(EXPECTED_TARGETS).sort());
    expect(Object.isFrozen(AuditTarget)).toBe(true);
  });
});

describe("recordAudit", () => {
  it("maps the actor and optional fields into the create payload and returns the row", async () => {
    const created = { id: "audit-1" };
    const create = vi.fn().mockResolvedValue(created);
    const prisma = createPrisma(create);

    const row = await recordAudit({
      prisma,
      actor: { id: "admin-1", username: "alice" },
      action: AuditAction.STICKER_UPDATE,
      target_type: AuditTarget.STICKER,
      target_id: "sticker-1",
      app_id: "app-1",
      metadata: { changed: ["tags"] },
    });

    expect(create).toHaveBeenCalledTimes(1);
    const [args] = create.mock.calls[0];
    expect(args.data).toEqual({
      admin_id: "admin-1",
      admin_username: "alice",
      action: "sticker.update",
      target_type: "sticker",
      target_id: "sticker-1",
      app_id: "app-1",
      metadata: { changed: ["tags"] },
    });
    expect(row).toBe(created);
  });

  it("omits metadata (or leaves it undefined) when not provided", async () => {
    const create = vi.fn().mockResolvedValue({ id: "audit-2" });
    const prisma = createPrisma(create);

    await recordAudit({
      prisma,
      actor: { id: "admin-1", username: "alice" },
      action: AuditAction.STICKER_CREATE,
      target_type: AuditTarget.JOB,
      target_id: "job-1",
      app_id: "app-1",
    });

    const [args] = create.mock.calls[0];
    expect(args.data).toEqual({
      admin_id: "admin-1",
      admin_username: "alice",
      action: "sticker.create",
      target_type: "job",
      target_id: "job-1",
      app_id: "app-1",
    });
    expect(args.data.metadata).toBeUndefined();
  });

  it("writes nulls when the actor and optional target fields are missing", async () => {
    const create = vi.fn().mockResolvedValue({ id: "audit-3" });
    const prisma = createPrisma(create);

    await recordAudit({
      prisma,
      action: AuditAction.STICKER_DELETE,
      target_type: AuditTarget.STICKER,
    });

    const [args] = create.mock.calls[0];
    expect(args.data).toEqual({
      admin_id: null,
      admin_username: null,
      action: "sticker.delete",
      target_type: "sticker",
      target_id: null,
      app_id: null,
    });
    expect(args.data.metadata).toBeUndefined();
  });

  it("swallows create failures, logs via logger.error, and resolves to null", async () => {
    const error = new Error("audit table unavailable");
    const create = vi.fn().mockRejectedValue(error);
    const logger = { error: vi.fn() };

    await expect(
      recordAudit({
        prisma: createPrisma(create),
        actor: { id: "admin-1", username: "alice" },
        action: AuditAction.STICKER_HIDE,
        target_type: AuditTarget.STICKER,
        target_id: "sticker-1",
        app_id: "app-1",
        logger,
      }),
    ).resolves.toBeNull();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("does not throw on create failure when no logger is provided", async () => {
    const create = vi.fn().mockRejectedValue(new Error("audit table unavailable"));

    await expect(
      recordAudit({
        prisma: createPrisma(create),
        action: AuditAction.STICKER_UNHIDE,
        target_type: AuditTarget.STICKER,
        target_id: "sticker-1",
        app_id: "app-1",
      }),
    ).resolves.toBeNull();
  });
});
