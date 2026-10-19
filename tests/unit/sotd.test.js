import { describe, it, expect } from "vitest";
import { utcDateString, sotdKey, pickSticker } from "../../src/lib/sotd.js";

describe("sotd helpers", () => {
  it("formats the UTC calendar day", () => {
    expect(utcDateString(new Date("2026-10-19T23:59:59Z"))).toBe("2026-10-19");
    expect(utcDateString(new Date("2026-10-20T00:00:00Z"))).toBe("2026-10-20");
  });

  it("builds a per-app, per-day key", () => {
    expect(sotdKey("app-1", "2026-10-19")).toBe("sotd:app-1:2026-10-19");
  });

  it("is deterministic for the same seed", () => {
    const images = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const first = pickSticker(images, "seed");
    expect(pickSticker(images, "seed")).toBe(first);
    expect(images.map((i) => i.id)).toContain(first.id);
  });

  it("returns null for an empty candidate set", () => {
    expect(pickSticker([], "seed")).toBeNull();
  });

  it("returns the only candidate", () => {
    expect(pickSticker([{ id: "only" }], "seed")).toEqual({ id: "only" });
  });
});
