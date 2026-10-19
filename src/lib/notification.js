/** Shared notification-dispatch constants and helpers (context.md §4.11). */

/** FCM multicast hard limit per request. */
export const FCM_BATCH_SIZE = 500;

/** `INACTIVE` targeting looks back this many days (§4.11, "≥3 days old"). */
export const INACTIVE_DAYS = 3;

/** NotificationLog `type` written by the manual broadcast dispatcher. */
export const NOTIFICATION_LOG_TYPE = "BROADCAST";

/** NotificationLog `type` written by the event-driven search-match dispatcher. */
export const NOTIFICATION_LOG_TYPE_SEARCH_MATCH = "SEARCH_MATCH";

/** `SEARCH_MATCH` only considers searches from the last 48 hours (§4.11). */
export const SEARCH_MATCH_WINDOW_HOURS = 48;

/**
 * Manual broadcast audiences (context.md §4.11). `SEARCH_BASED` is intentionally
 * absent — the search-driven send is event-driven (`SEARCH_MATCH`, see
 * `dispatchSearchMatch`), not an admin-selectable campaign target.
 */
export const NotificationTarget = Object.freeze({
  ALL: "ALL",
  INACTIVE: "INACTIVE",
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC calendar day as `YYYY-MM-DD` (the app's canonical timezone is UTC). */
export function utcDay(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Cutoff for `INACTIVE` targeting: devices not seen since this instant. */
export function inactiveCutoff(now = new Date(), days = INACTIVE_DAYS) {
  return new Date(now.getTime() - days * DAY_MS);
}
