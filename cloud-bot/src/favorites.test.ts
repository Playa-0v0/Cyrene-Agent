import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FavoriteStore } from "./favorites.js";

test("雲端收藏會永久寫入並避免重複網址", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyrene-cloud-favorites-"));
  const filePath = path.join(directory, "music-favorites.json");
  const store = new FavoriteStore(filePath);
  await store.init();
  assert.equal((await store.save("https://example.com/list/1", "歌單一")).added, true);
  assert.equal((await store.save("https://example.com/list/1", "重複")).added, false);
  assert.equal(store.list()[0].title, "歌單一");
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).length, 1);
});
