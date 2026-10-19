import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { enqueueBulkUpload } from "../../src/queues/bulk.queue.js";
import { StickerJob } from "../../src/queues/sticker.queue.js";
import { summarizeBulkJob } from "../../src/workers/sticker.worker.js";

function createFakeFlowProducer() {
  const trees = [];
  return {
    trees,
    async add(tree) {
      trees.push(tree);
      return { job: { id: tree.opts.jobId }, children: [] };
    },
  };
}

const image = Buffer.from("fake-image-bytes");

describe("enqueueBulkUpload", () => {
  it("builds a parent job with one child upload per image", async () => {
    const flowProducer = createFakeFlowProducer();
    const appId = randomUUID();

    const job = await enqueueBulkUpload({
      flowProducer,
      app_id: appId,
      is_animated: false,
      is_premium: true,
      emojis: ["😀"],
      tags: ["cats"],
      entries: [
        { filename: "a.png", buffer: image },
        { filename: "b.webp", buffer: image },
      ],
    });

    expect(job.id).toBeTruthy();
    const tree = flowProducer.trees[0];
    expect(tree.name).toBe(StickerJob.BULK);
    expect(tree.queueName).toBe("sticker-processing");
    expect(tree.data).toMatchObject({ app_id: appId, total: 2 });
    expect(tree.data.entries.map((e) => e.filename)).toEqual(["a.png", "b.webp"]);

    expect(tree.children).toHaveLength(2);
    for (const child of tree.children) {
      expect(child.name).toBe(StickerJob.UPLOAD);
      expect(child.data).toMatchObject({
        app_id: appId,
        is_premium: true,
        is_animated: false,
        emojis: ["😀"],
        tags: ["cats"],
        image_base64: image.toString("base64"),
      });
      expect(child.opts.jobId).toBeTruthy();
      expect(child.opts.ignoreDependencyOnFailure).toBe(true);
    }

    // Parent records the child ids so it can join results back to filenames.
    expect(tree.data.entries.map((e) => e.job_id)).toEqual(
      tree.children.map((child) => child.opts.jobId),
    );
  });
});

describe("summarizeBulkJob", () => {
  it("joins child results and failures back to filenames", async () => {
    const data = {
      app_id: randomUUID(),
      total: 3,
      entries: [
        { filename: "a.png", job_id: "id-a" },
        { filename: "b.png", job_id: "id-b" },
        { filename: "c.png", job_id: "id-c" },
      ],
    };

    const job = {
      async getChildrenValues() {
        return {
          "bull:sticker-processing:id-a": { image_id: "img-a", image_url: "https://x/a.webp" },
          "bull:sticker-processing:id-c": { image_id: "img-c", image_url: "https://x/c.webp" },
        };
      },
      async getFailedChildrenValues() {
        return { "bull:sticker-processing:id-b": "Unsupported image." };
      },
    };

    const result = await summarizeBulkJob({ job, data });
    expect(result).toEqual({
      total: 3,
      completed: 2,
      failed: 1,
      results: [
        { filename: "a.png", status: "completed", sticker_id: "img-a" },
        { filename: "b.png", status: "failed", error: "Unsupported image." },
        { filename: "c.png", status: "completed", sticker_id: "img-c" },
      ],
    });
  });

  it("reports a missing child result as failed", async () => {
    const job = {
      async getChildrenValues() {
        return {};
      },
      async getFailedChildrenValues() {
        return {};
      },
    };
    const result = await summarizeBulkJob({
      job,
      data: {
        app_id: randomUUID(),
        total: 1,
        entries: [{ filename: "x.png", job_id: "id-x" }],
      },
    });
    expect(result.failed).toBe(1);
    expect(result.results[0]).toMatchObject({ filename: "x.png", status: "failed" });
  });
});
