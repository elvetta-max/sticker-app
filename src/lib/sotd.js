import { createHash } from "node:crypto";
import { DAY_MS } from "./search.js";

/** Sticker-of-the-Day constants (context.md §4.15). */
export const SOTD_RECENT_DAYS = 30;

/** Deterministic per-day pick runs at 00:05 UTC. */
export const SOTD_CRON = "5 0 * * *";

/** Keep yesterday's pick around briefly; each day writes a fresh key. */
export const SOTD_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * A deterministic weighted-random pick, seeded from the app + day so every user (and
 * the worker) converges on the same sticker. Weight = 3×downloads + shares + 1, the
 * same engagement bias as trending.
 * @param {{ id: string, downloads?: number, shares?: number }[]} images
 * @param {string} seed
 */
export function pickSticker(images, seed) {
  if (!images || images.length === 0) return null;
  const weights = images.map((image) => (image.downloads ?? 0) * 3 + (image.shares ?? 0) + 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = seededUnit(seed) * total;
  for (let i = 0; i < images.length; i += 1) {
    target -= weights[i];
    if (target < 0) return images[i];
  }
  return images[images.length - 1];
}

/** A single deterministic [0,1) value from a string seed (SHA-256 → mulberry32). */
function seededUnit(seed) {
  const digest = createHash("sha256").update(seed).digest();
  let a = digest.readUInt32BE(0) || 1;
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** UTC calendar day (`YYYY-MM-DD`) — the canonical throttle day (context.md §5.3). */
export function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** @param {string} appId @param {string} date */
export function sotdKey(appId, date) {
  return `sotd:${appId}:${date}`;
}

/** @param {string} appId @param {string} date */
export function sotdSeed(appId, date) {
  return `${appId}:${date}`;
}

/**
 * Choose today's sticker for one app: recent (≤30 days) visible stickers,
 * deterministically weighted; falls back to any visible sticker when the recent
 * window is empty (context.md §4.15). Returns the chosen image row or `null`.
 *
 * @param {{ prisma: any, appId: string, now?: Date }} args
 */
export async function selectDailySticker({ prisma, appId, now = new Date() }) {
  const select = { id: true, downloads: true, shares: true, created_at: true };
  const cutoff = new Date(now.getTime() - SOTD_RECENT_DAYS * DAY_MS);

  let images = await prisma.image.findMany({
    where: { app_id: appId, is_hidden: false, created_at: { gte: cutoff } },
    select,
  });
  if (images.length === 0) {
    images = await prisma.image.findMany({
      where: { app_id: appId, is_hidden: false },
      select,
    });
  }
  if (images.length === 0) return null;

  images.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return pickSticker(images, sotdSeed(appId, utcDateString(now)));
}
