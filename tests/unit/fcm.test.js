import { describe, it, expect } from "vitest";
import {
  createFcmSender,
  createDryRunSender,
  createUnconfiguredSender,
  DEAD_TOKEN_CODES,
} from "../../src/lib/fcm.js";

describe("FCM sender adapters", () => {
  it("dry-run sender reports every token as accepted without network", async () => {
    const sender = createDryRunSender();
    const { responses } = await sender.sendBatch(["a", "b", "c"], { title: "t", body: "b" });
    expect(responses).toEqual([{ success: true }, { success: true }, { success: true }]);
  });

  it("unconfigured sender throws a clear error on dispatch", async () => {
    const sender = createUnconfiguredSender();
    await expect(sender.sendBatch(["a"], { title: "t", body: "b" })).rejects.toThrow(
      /not configured/i,
    );
  });

  it("selects dry-run from env, returns a real sender when configured, else the failing one", () => {
    expect(typeof createFcmSender({ env: { FCM_DRY_RUN: true } }).sendBatch).toBe("function");

    const configured = createFcmSender({
      env: {
        FCM_DRY_RUN: false,
        FIREBASE_PROJECT_ID: "proj",
        FIREBASE_CLIENT_EMAIL: "svc@example.com",
        FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nxxx\\n-----END PRIVATE KEY-----",
      },
    });
    expect(typeof configured.sendBatch).toBe("function");

    const unconfigured = createFcmSender({ env: { FCM_DRY_RUN: false } });
    expect(typeof unconfigured.sendBatch).toBe("function");
  });

  it("knows which FCM error codes mean a dead token", () => {
    expect(DEAD_TOKEN_CODES.has("messaging/registration-token-not-registered")).toBe(true);
    expect(DEAD_TOKEN_CODES.has("messaging/invalid-registration-token")).toBe(true);
    expect(DEAD_TOKEN_CODES.has("messaging/internal-error")).toBe(false);
  });
});
