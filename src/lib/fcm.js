import { logger } from "../config/logger.js";
import { env as defaultEnv } from "../config/env.js";

/**
 * FCM sender adapters (context.md §4.11). Firebase Admin SDK is the only push
 * channel. The sender is injected everywhere so tests never touch the network and
 * the worker can run in dry-run mode when credentials are absent (local/dev).
 *
 * Sender contract:
 *   sendBatch(tokens: string[], message: { title, body, data? })
 *     -> Promise<{ responses: Array<{ success: boolean, dead?: boolean }> }>
 * `responses` is aligned by index with `tokens`; `dead` marks a token FCM reported
 * as permanently invalid (safe to delete from the device table).
 */

/** FCM error codes that mean the token is permanently dead (§4.11). */
export const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/**
 * Sender that reports every token as accepted without contacting FCM. Used when
 * `FCM_DRY_RUN=true` (local/dev) so the whole dispatch pipeline can be exercised.
 */
export function createDryRunSender() {
  return {
    async sendBatch(tokens) {
      return { responses: tokens.map(() => ({ success: true })) };
    },
  };
}

/** Sender whose `sendBatch` always fails — used when FCM is enabled but unconfigured. */
export function createUnconfiguredSender() {
  return {
    async sendBatch() {
      throw new Error(
        "FCM is not configured: set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / " +
          "FIREBASE_PRIVATE_KEY (or FCM_DRY_RUN=true for local testing).",
      );
    },
  };
}

/**
 * Real Firebase Admin SDK sender. The SDK is imported lazily on first send so the
 * module (and the API/worker boot path) never requires Firebase at load time.
 * @param {{ FIREBASE_PROJECT_ID: string, FIREBASE_CLIENT_EMAIL: string, FIREBASE_PRIVATE_KEY: string }} env
 */
export function createFirebaseSender(env) {
  let messagingPromise = null;

  function getMessaging() {
    messagingPromise ??= (async () => {
      const { initializeApp, cert, getApps } = await import("firebase-admin/app");
      const { getMessaging: getMessagingInstance } = await import("firebase-admin/messaging");
      const app = getApps().length
        ? getApps()[0]
        : initializeApp({
            credential: cert({
              projectId: env.FIREBASE_PROJECT_ID,
              clientEmail: env.FIREBASE_CLIENT_EMAIL,
              privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
            }),
          });
      return getMessagingInstance(app);
    })();
    return messagingPromise;
  }

  return {
    async sendBatch(tokens, message) {
      const messaging = await getMessaging();
      const result = await messaging.sendEachForMulticast({
        tokens,
        notification: { title: message.title, body: message.body },
        ...(message.data ? { data: message.data } : {}),
      });

      const responses = result.responses.map((response) => ({
        success: response.success,
        dead: !response.success && DEAD_TOKEN_CODES.has(response.error?.code),
      }));

      return { responses };
    },
  };
}

/**
 * Choose the FCM sender based on configuration: dry-run, real Firebase, or a
 * failing placeholder that surfaces the misconfiguration at dispatch time.
 * @param {{ env?: object, dryRun?: boolean }} [options]
 */
export function createFcmSender({ env = defaultEnv, dryRun } = {}) {
  const source = env ?? {};
  const useDryRun = dryRun ?? source.FCM_DRY_RUN === true;

  if (useDryRun) {
    logger.warn("FCM_DRY_RUN enabled: push notifications are simulated, not sent.");
    return createDryRunSender();
  }

  const configured =
    Boolean(source.FIREBASE_PROJECT_ID) &&
    Boolean(source.FIREBASE_CLIENT_EMAIL) &&
    Boolean(source.FIREBASE_PRIVATE_KEY);

  if (!configured) {
    logger.error(
      "FCM credentials are not configured; push dispatch will fail. " +
        "Set FIREBASE_* or FCM_DRY_RUN=true.",
    );
    return createUnconfiguredSender();
  }

  return createFirebaseSender(source);
}
