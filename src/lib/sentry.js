import { env } from "../config/env.js";

/**
 * Sentry error tracking (context.md §8). Configured entirely from env: an empty
 * `SENTRY_DSN` disables reporting and every function here becomes a safe no-op,
 * so local/test runs never touch the network.
 *
 * The SDK is imported lazily so a missing/disabled Sentry never costs startup time.
 */

/** Context keys promoted to Sentry tags (everything else stays in `extra`). */
const TAG_KEYS = ["request_id", "app_id", "route", "job_id", "job_name", "queue", "worker"];

let client = null;
let initialized = false;

/**
 * Initialize the SDK once. Returns whether Sentry is enabled afterwards.
 *
 * @param {{
 *   dsn?: string,
 *   environment?: string,
 *   release?: string,
 *   tracesSampleRate?: number,
 *   importer?: () => Promise<object>,
 * }} [options]
 * @returns {Promise<boolean>}
 */
export async function initSentry(options = {}) {
  if (initialized) return true;

  const {
    dsn = env.SENTRY_DSN,
    environment = env.SENTRY_ENVIRONMENT,
    release = env.SENTRY_RELEASE,
    tracesSampleRate = env.SENTRY_TRACES_SAMPLE_RATE,
    importer = () => import("@sentry/node"),
  } = options;

  if (!dsn) return false;

  const Sentry = await importer();
  Sentry.init({ dsn, environment, release, tracesSampleRate });

  client = Sentry;
  initialized = true;
  return true;
}

/**
 * Report an exception. Never throws — error reporting must not break the request
 * or job that hit it.
 *
 * @param {Error} err
 * @param {{
 *   request_id?: string, app_id?: string, route?: string, job_id?: string,
 *   job_name?: string, queue?: string, worker?: string, extra?: object,
 * }} [context]
 * @returns {boolean} true when handed to Sentry
 */
export function captureException(err, context = {}) {
  if (!client) return false;

  try {
    const tags = {};
    for (const key of TAG_KEYS) {
      const value = context[key];
      if (value !== undefined && value !== null) tags[key] = String(value);
    }
    client.captureException(err, { tags, extra: context.extra ?? {} });
    return true;
  } catch {
    return false;
  }
}

/** @returns {boolean} whether a Sentry client is active */
export function isSentryEnabled() {
  return client !== null;
}

/** Test-only: install a fake client. */
export function __setClientForTests(fake) {
  client = fake;
  initialized = fake !== null && fake !== undefined;
}

/** Test-only: clear the client and init flag. */
export function __resetForTests() {
  client = null;
  initialized = false;
}
