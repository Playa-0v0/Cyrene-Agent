import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startHealthServer } from "./health.js";
import { MemoryStore } from "./memory.js";

test("對話能寫入磁碟並在重啟後恢復", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cyrene-cloud-test-"));
  try {
    const first = new MemoryStore(directory, 10);
    await first.init();
    await first.append("session", "user", "晚安");
    const second = new MemoryStore(directory, 10);
    await second.init();
    assert.equal(second.get("session")[0]?.content, "晚安");
    assert.match(await readFile(path.join(directory, "discord-history.jsonl"), "utf8"), /晚安/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("健康檢查回傳 Discord 狀態", async () => {
  const server = startHealthServer(0, () => ({ discord: "connecting" }));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, discord: "connecting" });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
