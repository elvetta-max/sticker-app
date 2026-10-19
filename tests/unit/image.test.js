import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { processStickerImage, assertFrameCount, STICKER_SIZE } from "../../src/lib/image.js";

const fixture = (name) => readFile(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

const makePng = (w, h) =>
  sharp({
    create: { width: w, height: h, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  })
    .png()
    .toBuffer();

describe("processStickerImage", () => {
  it("resizes a landscape PNG to an exact 512×512 WebP", async () => {
    const out = await processStickerImage(await makePng(800, 400));
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(STICKER_SIZE);
    expect(meta.height).toBe(STICKER_SIZE);
    expect(out.is_animated).toBe(false);
    expect(out.pages).toBe(1);
  });

  it("processes a JPEG from disk", async () => {
    const out = await processStickerImage(await fixture("static.jpg"));
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(STICKER_SIZE);
  });

  it("preserves animation for a 5-frame GIF", async () => {
    const out = await processStickerImage(await fixture("animated-5.gif"), { isAnimated: true });
    expect(out.is_animated).toBe(true);
    expect(out.pages).toBe(5);
    const meta = await sharp(out.buffer, { animated: true }).metadata();
    // libwebp may coalesce a frame during encode; assert animation survived regardless.
    expect(meta.pages).toBeGreaterThanOrEqual(2);
    expect(meta.width).toBe(STICKER_SIZE);
  });

  it("rejects animated images over 30 frames", async () => {
    const buf = await fixture("animated-40.gif");
    await expect(processStickerImage(buf, { isAnimated: true })).rejects.toMatchObject({
      status: 422,
    });
  });

  it("rejects non-image garbage", async () => {
    await expect(processStickerImage(Buffer.from("not an image at all"))).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe("assertFrameCount", () => {
  it("allows up to 30 frames and rejects above", () => {
    expect(() => assertFrameCount(30)).not.toThrow();
    expect(() => assertFrameCount(31)).toThrow();
    expect(() => assertFrameCount(undefined)).not.toThrow();
  });
});
