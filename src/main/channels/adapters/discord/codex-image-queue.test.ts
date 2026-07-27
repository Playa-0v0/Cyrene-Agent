import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexImageJob,
  createCodexImageQueueTestRoot,
  listCodexImageDeliveries,
  markCodexImageDeliveryProcessed,
  validateCodexImageOutput,
} from "./codex-image-queue";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Codex Discord image queue", () => {
  it("creates an owner-bound job and delivers only trusted output files", () => {
    const root = createCodexImageQueueTestRoot();
    roots.push(root);
    const job = createCodexImageJob({
      prompt: "昔漣站在星空花園",
      requestedByUserId: "798893182883463179",
      requestedByName: "Clark",
      responseChannelId: "1530923507750273078",
      responseGuildId: "1530923507750273079",
    }, root);
    const imagePath = path.join(root, "output", `${job.id}.png`);
    fs.writeFileSync(imagePath, "png");
    fs.writeFileSync(path.join(root, "completed", `${job.id}.json`), JSON.stringify({
      jobId: job.id,
      status: "completed",
      imagePath,
      completedAt: new Date().toISOString(),
    }));

    const deliveries = listCodexImageDeliveries(root);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].job.requestedByUserId).toBe("798893182883463179");
    expect(deliveries[0].job.promptMode).toBe("keywords");
    expect(deliveries[0].job.responseChannelId).toBe("1530923507750273078");
    expect(deliveries[0].job.responseGuildId).toBe("1530923507750273079");
    expect(validateCodexImageOutput(imagePath, root)).toBe(fs.realpathSync(imagePath));
    markCodexImageDeliveryProcessed(deliveries[0], root);
    expect(listCodexImageDeliveries(root)).toHaveLength(0);
  });

  it("rejects output paths outside the bridge directory", () => {
    const root = createCodexImageQueueTestRoot();
    roots.push(root);
    const outside = path.join(root, "outside.png");
    fs.writeFileSync(outside, "png");
    expect(() => validateCodexImageOutput(outside, root)).toThrow(/受信任/);
  });
});
