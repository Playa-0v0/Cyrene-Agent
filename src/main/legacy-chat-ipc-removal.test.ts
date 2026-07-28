import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC } from "../shared/ipc-channels";

const readSource = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), "src", relativePath), "utf8");

describe("legacy chat IPC removal", () => {
  it("does not expose the superseded request or stream channels", () => {
    const legacyKeys = [
      ["CHAT", "SEND", "MESSAGE"].join("_"),
      ["CHAT", "STREAM", "CHUNK"].join("_"),
      ["CHAT", "STREAM", "DONE"].join("_"),
    ];

    for (const key of legacyKeys) {
      expect(IPC).not.toHaveProperty(key);
    }
  });

  it("keeps renderer, preload, and main on the AG-UI path only", () => {
    const renderer = readSource("renderer/chat/main.ts");
    const preload = readSource("preload/index.ts");
    const main = readSource("main/index.ts");

    expect(renderer).not.toContain(["get", "Model", "Reply"].join(""));
    expect(preload).not.toContain(["on", "Stream", "Chunk"].join(""));
    expect(preload).not.toContain(["on", "Stream", "Done"].join(""));
    expect(main).not.toContain(["request", "Model", "Reply"].join(""));
  });
});
