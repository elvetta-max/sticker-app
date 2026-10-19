import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { sniffImageType, singleImage, verifyImageSignature } from "../../src/middleware/upload.js";
import { errorHandler, notFound } from "../../src/middleware/errorHandler.js";
import { processStickerImage } from "../../src/lib/image.js";
import sharp from "sharp";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP"),
  Buffer.alloc(4),
]);

describe("sniffImageType", () => {
  it("detects png, jpeg and webp", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("rejects unknown/short buffers", () => {
    expect(sniffImageType(Buffer.from("hello world!"))).toBeNull();
    expect(sniffImageType(Buffer.from([1, 2, 3]))).toBeNull();
  });
});

describe("upload middleware", () => {
  let app;
  let imageBuffer;

  beforeAll(async () => {
    app = express();
    app.post("/img", singleImage("image"), verifyImageSignature, (req, res) => {
      res.json({ ok: true, detected: req.file.detectedMime });
    });
    app.use(notFound);
    app.use(errorHandler);

    imageBuffer = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
  });

  afterAll(() => {});

  it("accepts a valid image and reports the sniffed type", async () => {
    const res = await request(app)
      .post("/img")
      .attach("image", imageBuffer, { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body.detected).toBe("image/png");
  });

  it("rejects a disallowed mime type", async () => {
    const res = await request(app).post("/img").attach("image", Buffer.from("plain text"), {
      filename: "a.txt",
      contentType: "text/plain",
    });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a spoofed mimetype whose bytes do not match", async () => {
    const res = await request(app).post("/img").attach("image", Buffer.from("GIF89a not really"), {
      filename: "a.png",
      contentType: "image/png",
    });
    expect(res.status).toBe(415);
  });

  it("requires a file", async () => {
    const res = await request(app).post("/img");
    expect(res.status).toBe(400);
  });

  it("rejects files over the 5 MB cap", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0xff);
    // Give it a valid PNG signature so only the size limit can trip it.
    PNG.copy(big, 0);
    const res = await request(app)
      .post("/img")
      .attach("image", big, { filename: "big.png", contentType: "image/png" });
    expect(res.status).toBe(413);
  });
});

describe("processed output round-trips through the signature check", () => {
  it("produces a buffer sniffable as webp", async () => {
    const src = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer();
    const { buffer } = await processStickerImage(src);
    expect(sniffImageType(buffer)).toBe("image/webp");
  });
});
