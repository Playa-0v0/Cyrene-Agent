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

test("雲端永久原文不受短期滑窗與 forget 影響，並能主動跨會話召回", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cyrene-cloud-memory-"));
  try {
    const store = new MemoryStore(directory, 4);
    await store.init();
    await store.append("old-channel", "user", "下次旅行我想去冰島看極光", { id: "old:user" });
    await store.append("old-channel", "assistant", "我會記得", { id: "old:assistant" });
    for (let index = 0; index < 6; index += 1) {
      await store.append("new-channel", "user", `普通訊息 ${index}`, { id: `new:${index}:user` });
      await store.append("new-channel", "assistant", `普通回覆 ${index}`, { id: `new:${index}:assistant` });
    }
    await store.forget("old-channel");

    assert.equal(store.get("old-channel").length, 0);
    assert.equal(store.archiveCount(), 14);
    assert.match(store.buildRecallContext("我之前說想去哪裡看極光", "new-channel"), /冰島看極光/);

    const restarted = new MemoryStore(directory, 4);
    await restarted.init();
    assert.equal(restarted.archiveCount(), 14);
    assert.equal(restarted.get("old-channel").length, 0);
    assert.match(restarted.buildRecallContext("冰島極光", "another-channel"), /下次旅行我想去冰島看極光/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("相同 Discord 事件 ID 不會重複寫入永久記憶", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cyrene-cloud-dedupe-"));
  try {
    const store = new MemoryStore(directory, 8);
    await store.init();
    assert.equal(await store.append("session", "user", "晚安", { id: "message:1" }), true);
    assert.equal(await store.append("session", "user", "晚安", { id: "message:1" }), false);
    assert.equal(store.archiveCount(), 1);
    assert.equal((await readFile(path.join(directory, "discord-history.jsonl"), "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("照片描述永久保存、可召回但不偽裝成短期聊天訊息", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cyrene-cloud-photo-memory-"));
  try {
    const store = new MemoryStore(directory, 8);
    await store.init();
    await store.append("session", "assistant", "【照片內容永久記憶】圖片裡有戴藍帽的橘貓，旁邊寫著生日快樂", {
      id: "photo:1",
      kind: "image_memory",
      includeInShortTerm: false,
    });

    assert.equal(store.get("session").length, 0);
    assert.match(store.buildRecallContext("之前那隻戴藍帽的貓", "other-session"), /戴藍帽的橘貓/);
    assert.match(store.buildRecallContext("生日快樂", "other-session"), /昔漣看見的照片內容/);

    const restarted = new MemoryStore(directory, 8);
    await restarted.init();
    assert.equal(restarted.get("session").length, 0);
    assert.match(restarted.buildRecallContext("橘貓", "other-session"), /照片內容永久記憶/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import http from "node:http";

test("健康檢查回傳 Discord 與雲端通話狀態", async () => {
  const server = startHealthServer(0, () => ({ discord: "connecting", voiceActive: true }));
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", resolve));
  }
  const address = server.address();

  assert.ok(address && typeof address !== "string");
  const data = await new Promise<string>((resolve, reject) => {
    http.get(`http://127.0.0.1:${address.port}/health`, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
  assert.deepEqual(JSON.parse(data), { ok: true, discord: "connecting", voiceActive: true });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

