import { z } from "zod";

/**
 * Multipart text fields arrive as strings (or repeated fields as arrays).
 * Accept either a JSON array string ("[\"a\",\"b\"]") or a comma-separated list.
 * @param {unknown} value
 * @returns {string[]}
 */
export function toStringArray(value) {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap((entry) => {
    const text = String(entry).trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.map((v) => String(v).trim()).filter(Boolean) : [text];
      } catch {
        return [text];
      }
    }
    return text
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  });
}

/** Accepts booleans or their multipart string forms ("true"/"1"/"yes"). */
const booleanField = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes"].includes(String(value).toLowerCase());
}, z.boolean().optional());

/** Body for `POST /api/admin/stickers` (multipart form fields). */
export const createStickerSchema = z.object({
  app_id: z.uuid(),
  is_premium: booleanField.default(false),
  is_animated: booleanField.default(false),
  emojis: z.preprocess(toStringArray, z.array(z.string().min(1)).max(20)).default([]),
  tags: z.preprocess(toStringArray, z.array(z.string().trim().min(1).max(40)).max(20)).default([]),
});

/** Preserves "field absent" (undefined) instead of collapsing to an empty list. */
const optionalList = (item) =>
  z.preprocess(
    (value) => (value === undefined ? undefined : toStringArray(value)),
    z.array(item).max(20).optional(),
  );

/**
 * Body for `PUT /api/admin/stickers/{id}` — every field optional; only provided
 * fields are changed (context.md §4.9). Accepts JSON or multipart string forms.
 */
export const updateStickerSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.object({
    is_premium: booleanField,
    is_animated: booleanField,
    emojis: optionalList(z.string().min(1)),
    tags: optionalList(z.string().trim().min(1).max(40)),
  }),
);
