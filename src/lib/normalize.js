/**
 * Normalize a raw search keyword (context.md §5.2).
 * Diacritics + Arabic tashkeel stripped, lowercased, punctuation -> spaces,
 * collapsed whitespace, truncated to 64 chars.
 *
 * NOTE: context.md §5.2 ends with `/[^a-z0-9\s]/g`, which would delete Arabic
 * letters entirely and make its own tashkeel-stripping step pointless. We use the
 * Unicode-aware `[^\p{L}\p{N}\s]` so non-Latin scripts (e.g. Arabic) survive.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeKeyword(raw = "") {
  return String(raw)
    .normalize("NFKD")
    .replace(/[\u064B-\u0652]/g, "")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

export default normalizeKeyword;
