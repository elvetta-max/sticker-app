import { z } from "zod";
import { toStringArray } from "./admin.stickers.schema.js";

/** Multipart boolean field accepting "true"/"1"/"yes". */
const booleanField = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes"].includes(String(value).toLowerCase());
}, z.boolean().optional());

/** Body for `POST /api/admin/stickers/bulk` (context.md §4.17). */
export const bulkStickerSchema = z.object({
  app_id: z.uuid(),
  is_premium: booleanField.default(false),
  is_animated: booleanField.default(false),
  emojis: z.preprocess(toStringArray, z.array(z.string().min(1)).max(20)).default([]),
  tags: z.preprocess(toStringArray, z.array(z.string().trim().min(1).max(40)).max(20)).default([]),
});
