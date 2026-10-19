import { describe, it, expect } from "vitest";
import { buildZip } from "../fixtures/zip-builder.js";
import {
  readZipEntries,
  isSafeZipPath,
  zipEntryExtension,
  BULK_MAX_IMAGES,
} from "../../src/lib/zip.js";

describe("readZipEntries", () => {
  it("reads stored and deflated entries", () => {
    const entries = readZipEntries(
      buildZip([
        { name: "a.png", data: Buffer.from("stored") },
        { name: "nested/b.webp", data: Buffer.from("deflated-data"), method: 8 },
      ]),
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ filename: "a.png", buffer: Buffer.from("stored") });
    expect(entries[1].filename).toBe("nested/b.webp");
    expect(entries[1].buffer.toString()).toBe("deflated-data");
  });

  it("skips directory entries and tolerates an archive comment", () => {
    const entries = readZipEntries(
      buildZip(
        [
          { name: "folder/", data: Buffer.alloc(0) },
          { name: "folder/c.jpg", data: Buffer.from("img") },
        ],
        { comment: "hello" },
      ),
    );
    expect(entries.map((e) => e.filename)).toEqual(["folder/c.jpg"]);
  });

  it("rejects zip-slip paths", () => {
    for (const name of ["../evil.png", "a/../../evil.png", "/etc/passwd", "C:/x.png"]) {
      expect(() => readZipEntries(buildZip([{ name, data: Buffer.from("x") }]))).toThrow(
        /Unsafe path/,
      );
    }
  });

  it("enforces the entry-count and per-entry size caps", () => {
    const files = Array.from({ length: BULK_MAX_IMAGES + 1 }, (_, i) => ({
      name: `${i}.png`,
      data: Buffer.from("x"),
    }));
    expect(() => readZipEntries(buildZip(files))).toThrow(/more than 200 files/);

    expect(() =>
      readZipEntries(buildZip([{ name: "big.png", data: Buffer.alloc(2048) }]), {
        maxEntryBytes: 1024,
      }),
    ).toThrow(/exceeds/);
  });

  it("rejects a non-zip buffer", () => {
    expect(() => readZipEntries(Buffer.from("not a zip"))).toThrow(/not a valid ZIP/);
  });
});

describe("zip path helpers", () => {
  it("classifies safe and unsafe paths", () => {
    expect(isSafeZipPath("a/b.png")).toBe(true);
    expect(isSafeZipPath("b.png")).toBe(true);
    expect(isSafeZipPath("../b.png")).toBe(false);
    expect(isSafeZipPath("a\\..\\b.png")).toBe(false);
    expect(isSafeZipPath("")).toBe(false);
  });

  it("extracts lowercase extensions", () => {
    expect(zipEntryExtension("dir/Photo.JPG")).toBe(".jpg");
    expect(zipEntryExtension("dir/photo.webp")).toBe(".webp");
    expect(zipEntryExtension("noext")).toBe("");
  });
});
