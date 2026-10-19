import { describe, it, expect } from "vitest";
import { normalizeKeyword } from "../../src/lib/normalize.js";

describe("normalizeKeyword", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalizeKeyword("Café")).toBe("cafe");
  });

  it("replaces punctuation with spaces and collapses whitespace", () => {
    expect(normalizeKeyword("Hello, World!")).toBe("hello world");
  });

  it("strips Arabic tashkeel", () => {
    expect(normalizeKeyword("قَطّ")).toBe("قط");
  });

  it("trims and returns empty string for blank input", () => {
    expect(normalizeKeyword("   ")).toBe("");
    expect(normalizeKeyword(undefined)).toBe("");
  });

  it("truncates to 64 characters", () => {
    expect(normalizeKeyword("a".repeat(100))).toHaveLength(64);
  });
});
