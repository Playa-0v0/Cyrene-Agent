// CacheDownloader unit tests — real fs with temp dirs, mocked global fetch.
// 覆盖：下载完成收录 / 失败不收录 / Promise 复用去重 / 原子写索引 / reconcile 对账 / remove / importFiles
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Readable } from "node:stream";
import { CacheDownloader } from "./cache-downloader";
import type { MusicTrack } from "./types";

const ENC = "4C777A98B81DF0CC069B59F63F3882B1";

function makeTrack(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: ENC,
    name: "晴天",
    artists: ["周杰伦"],
    durationMs: 269000,
    ...overrides,
  };
}

function mockFetchOk(content: Buffer, opts: { contentLength?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: opts.status === undefined || opts.status < 400,
    status: opts.status ?? 200,
    headers: new Headers(
      opts.contentLength === false ? {} : { "content-length": String(content.length) },
    ),
    body: Readable.toWeb(Readable.from([content])),
  }));
}

let tmpRoot: string;
let cacheDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-cache-test-"));
  cacheDir = path.join(tmpRoot, "music-cache");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("CacheDownloader — download", () => {
  it("download 成功 → 文件收录 + 索引持久化 + isCached/listTracks 可见", async () => {
    const content = Buffer.from("fake-mp3-audio-data");
    vi.stubGlobal("fetch", mockFetchOk(content));
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();

    const result = await dl.download(makeTrack(), "http://cdn/enc.mp3");
    expect(result.ok).toBe(true);
    expect(result.filePath).toBeTruthy();

    // 双条件命中
    expect(dl.isCached(ENC)).toBe(true);
    const filePath = dl.getFilePath(ENC)!;
    expect(await fs.readFile(filePath)).toEqual(content);

    // 索引持久化（原子写：tmp 不残留）
    const indexRaw = await fs.readFile(path.join(cacheDir, "index.json"), "utf8");
    const index = JSON.parse(indexRaw) as Array<{ encryptedId: string; name: string }>;
    expect(index).toHaveLength(1);
    expect(index[0].encryptedId).toBe(ENC);
    expect(index[0].name).toBe("晴天");
    await expect(fs.access(path.join(cacheDir, "index.json.tmp"))).rejects.toThrow();

    // listTracks 返回曲目（含元数据）
    const tracks = dl.listTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: ENC, name: "晴天", artists: ["周杰伦"] });

    // .part 已清理
    await expect(fs.access(path.join(cacheDir, `${ENC}.mp3.part`))).rejects.toThrow();
  });

  it("已缓存的歌重复 download → 跳过且不再打网络", async () => {
    const content = Buffer.from("fake-mp3-audio-data");
    const fetchMock = mockFetchOk(content);
    vi.stubGlobal("fetch", fetchMock);
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();

    await dl.download(makeTrack(), "http://cdn/enc.mp3");
    const r2 = await dl.download(makeTrack(), "http://cdn/enc2.mp3");
    expect(r2.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("下载失败（网络错误）→ 不收录、.part 清理", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();

    const result = await dl.download(makeTrack(), "http://cdn/enc.mp3");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("E_CACHE_DOWNLOAD_FAILED");
    expect(dl.isCached(ENC)).toBe(false);
    expect(dl.listTracks()).toHaveLength(0);
    await expect(fs.access(path.join(cacheDir, `${ENC}.mp3.part`))).rejects.toThrow();
  });

  it("Content-Length 不匹配 → 视为失败不收录", async () => {
    const content = Buffer.from("short");
    // 伪造不一致：响应体只有 5 字节，但标头声称 999
    const lyingFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "999" }),
      body: Readable.toWeb(Readable.from([content])),
    }));
    vi.stubGlobal("fetch", lyingFetch);
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();

    const result = await dl.download(makeTrack(), "http://cdn/enc.mp3");
    expect(result.ok).toBe(false);
    expect(dl.isCached(ENC)).toBe(false);
  });

  it("并发两次 download 同一曲 → fetch 只打一次（Promise 复用）", async () => {
    const content = Buffer.from("fake-mp3-audio-data");
    const fetchMock = mockFetchOk(content);
    vi.stubGlobal("fetch", fetchMock);
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();

    const [r1, r2] = await Promise.all([
      dl.download(makeTrack(), "http://cdn/enc.mp3"),
      dl.download(makeTrack(), "http://cdn/enc.mp3"),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dl.isCached(ENC)).toBe(true);
  });

  it("下载完成后 getDownloadPromise 清空（inFlight 不泄漏）", async () => {
    const content = Buffer.from("fake-mp3-audio-data");
    vi.stubGlobal("fetch", mockFetchOk(content));
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();
    await dl.download(makeTrack(), "http://cdn/enc.mp3");
    expect(dl.getDownloadPromise(ENC)).toBeUndefined();
  });
});

describe("CacheDownloader — remove", () => {
  it("remove → 文件 + 索引同步删除", async () => {
    const content = Buffer.from("fake-mp3-audio-data");
    vi.stubGlobal("fetch", mockFetchOk(content));
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();
    await dl.download(makeTrack(), "http://cdn/enc.mp3");

    expect(await dl.remove(ENC)).toBe(true);
    expect(dl.isCached(ENC)).toBe(false);
    expect(dl.listTracks()).toHaveLength(0);
    await expect(fs.access(path.join(cacheDir, `${ENC}.mp3`))).rejects.toThrow();
    // 不存在的 → false
    expect(await dl.remove(ENC)).toBe(false);
  });
});

describe("CacheDownloader — reconcile（启动对账）", () => {
  it("索引有记录但文件被手动删 → 记录移除（不假命中）", async () => {
    const content = Buffer.from("fake-mp3-audio-data");
    vi.stubGlobal("fetch", mockFetchOk(content));
    const dl1 = new CacheDownloader(cacheDir);
    await dl1.initialize();
    await dl1.download(makeTrack(), "http://cdn/enc.mp3");

    // 模拟用户手动删文件
    await fs.rm(path.join(cacheDir, `${ENC}.mp3`));

    const dl2 = new CacheDownloader(cacheDir);
    await dl2.initialize();
    expect(dl2.isCached(ENC)).toBe(false);
    expect(dl2.listTracks()).toHaveLength(0);
  });

  it("孤儿 .part 与索引外音频文件 → 启动清理", async () => {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "orphan.mp3.part"), "partial");
    await fs.writeFile(path.join(cacheDir, "B".repeat(32) + ".mp3"), "no-index-file");
    await fs.writeFile(
      path.join(cacheDir, "index.json"),
      JSON.stringify([{ encryptedId: ENC, name: "晴天", artists: [], size: 1, cachedAt: 1, source: "netease", fileName: `${ENC}.mp3` }]),
    );
    // 索引指向的文件不存在

    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();

    const files = await fs.readdir(cacheDir);
    expect(files).toContain("index.json");
    expect(files).not.toContain("orphan.mp3.part");
    expect(files).not.toContain("B".repeat(32) + ".mp3");
    expect(files).not.toContain(`${ENC}.mp3`);
    expect(dl.listTracks()).toHaveLength(0);
  });
});

describe("CacheDownloader — importFiles", () => {
  it("导入本地文件 → 收录且 name 回退文件名（垃圾内容解析不出元数据）", async () => {
    const src = path.join(tmpRoot, "我的歌.mp3");
    await fs.writeFile(src, "garbage-not-real-mp3");
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();

    const result = await dl.importFiles([src]);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const tracks = dl.listTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id.startsWith("local-")).toBe(true);
    expect(tracks[0].name).toBe("我的歌");
    expect(dl.isCached(tracks[0].id)).toBe(true);
  });

  it("重复导入同一文件 → 去重跳过", async () => {
    const src = path.join(tmpRoot, "dup.mp3");
    await fs.writeFile(src, "same-content");
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();

    await dl.importFiles([src]);
    const r2 = await dl.importFiles([src]);
    expect(r2.imported).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(dl.listTracks()).toHaveLength(1);
  });

  it("不支持的扩展名 → 跳过", async () => {
    const src = path.join(tmpRoot, "note.txt");
    await fs.writeFile(src, "text");
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();
    const r = await dl.importFiles([src]);
    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(1);
    expect(dl.listTracks()).toHaveLength(0);
  });
});

describe("CacheDownloader — 索引变更广播", () => {
  it("下载完成 / 删除 / 导入都触发 updated 事件", async () => {
    const content = Buffer.from("fake-mp3-audio-data");
    vi.stubGlobal("fetch", mockFetchOk(content));
    const dl = new CacheDownloader(cacheDir);
    await dl.initialize();

    let fired = 0;
    dl.onUpdated(() => { fired++; });

    await dl.download(makeTrack(), "http://cdn/enc.mp3");
    expect(fired).toBe(1);

    await dl.remove(ENC);
    expect(fired).toBe(2);

    const src = path.join(tmpRoot, "another.mp3");
    await fs.writeFile(src, "more-garbage");
    await dl.importFiles([src]);
    expect(fired).toBe(3);
  });
});
