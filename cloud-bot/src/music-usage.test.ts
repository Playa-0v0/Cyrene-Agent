import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MusicUsageStore } from "./music-usage.js";

test("雲端音樂用量會持久保存並在上限停止", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-music-usage-"));
  const file = path.join(directory, "usage.json");
  const first = new MusicUsageStore(file, 2);
  await first.init();
  assert.equal(first.remaining(), 2);
  assert.equal(await first.addMinute(), 1);
  assert.equal(await first.addMinute(), 0);
  assert.equal(first.exhausted(), true);

  const restored = new MusicUsageStore(file, 2);
  await restored.init();
  assert.equal(restored.used(), 2);
  assert.equal(restored.exhausted(), true);
});
