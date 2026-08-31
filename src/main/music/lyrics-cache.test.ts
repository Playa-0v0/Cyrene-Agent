import { describe, it, expect, beforeEach } from "vitest";
import { LyricsCache } from "./lyrics-cache";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const ENC = "4C777A98B81DF0CC069B59F63F3882B1";

let dir = "";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lyrics-cache-"));
});

describe("LyricsCache", () => {
  it("miss returns null, then set/get round-trips（v2 含 translation 字段）", async () => {
    const c = new LyricsCache(dir);
    expect(await c.get(ENC)).toBeNull();
    const lines = [
      { timeMs: 12_000, text: "晴天" },
      { timeMs: 15_300, text: "故事的小黄花", translation: "the little yellow flower of the story" },
    ];
    await c.set(ENC, lines);
    expect(await c.get(ENC)).toEqual(lines);
  });

  it("v1 旧格式（裸数组）视为 miss → 触发重拉升级 v2", async () => {
    const c = new LyricsCache(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${ENC}.json`), JSON.stringify([{ timeMs: 0, text: "old" }]));
    expect(await c.get(ENC)).toBeNull();
    // 重拉后写入 v2 覆盖
    await c.set(ENC, [{ timeMs: 0, text: "new", translation: "新" }]);
    expect(await c.get(ENC)).toEqual([{ timeMs: 0, text: "new", translation: "新" }]);
  });

  it("caches empty [] (means: no lyrics — don't re-request)", async () => {
    const c = new LyricsCache(dir);
    await c.set(ENC, []);
    expect(await c.get(ENC)).toEqual([]);
  });

  it("rejects non-32-hex ids (no-op set, miss get) — path-traversal safe", async () => {
    const c = new LyricsCache(dir);
    await c.set("../../evil", [{ timeMs: 0, text: "x" }]);
    expect(await c.get("../../evil")).toBeNull();
    expect(await c.get(ENC.toLowerCase())).toBeNull(); // case-insensitive key
    const files = await fs.readdir(dir);
    expect(files).toEqual([]);
  });

  it("treats corrupt entries as a miss", async () => {
    const c = new LyricsCache(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${ENC}.json`), "not json");
    expect(await c.get(ENC)).toBeNull();
  });

  it("clear() wipes the cache dir", async () => {
    const c = new LyricsCache(dir);
    await c.set(ENC, [{ timeMs: 0, text: "x" }]);
    await c.clear();
    expect(await c.get(ENC)).toBeNull();
  });
});
