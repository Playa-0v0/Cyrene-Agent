// @vitest-environment jsdom
//
// 本地音乐卡片：文案分型 + 接线。文案部分重点在"没成功也要说清楚"——
// 取消、一首都没导入、被截断，三种情况不能都显示成"导入完成"。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const getMusicApiMock = vi.hoisted(() => vi.fn());
vi.mock("./panel", () => ({ getMusicApi: getMusicApiMock }));

import { describeImport, describeLibrary, initLocalMusicPanel } from "./local-panel";

describe("describeImport", () => {
  it("取消时明说取消，不说成功", () => {
    expect(describeImport({ imported: 0, skipped: 0, cancelled: true })).toContain("已取消");
  });

  it("一首都没有时明说没找到", () => {
    expect(describeImport({ imported: 0, skipped: 0 })).toContain("没有找到");
  });

  it("导入失败要说失败，不能伪装成「没找到文件」", () => {
    // 伪装成空结果的话，用户会去翻文件夹，而不是重试
    const t = describeImport({ imported: 0, skipped: 0, failed: true });
    expect(t).toContain("失败");
    expect(t).not.toContain("没有找到");
  });

  it("报告导入与跳过数量", () => {
    const t = describeImport({ imported: 12, skipped: 3 });
    expect(t).toContain("导入 12 首");
    expect(t).toContain("跳过 3 首");
  });

  it("被截断时必须提示，否则用户以为全导进来了", () => {
    expect(describeImport({ imported: 5000, skipped: 0, truncated: true })).toContain("上限");
  });

  it("没有跳过时不提跳过", () => {
    expect(describeImport({ imported: 4, skipped: 0 })).not.toContain("跳过");
  });
});

describe("describeLibrary", () => {
  it("空曲库引导用户导入", () => {
    const { text, tag } = describeLibrary(0);
    expect(text).toContain("导入文件夹");
    expect(tag).toBeNull();
  });

  it("有曲目时给出数量角标", () => {
    expect(describeLibrary(37)).toEqual({ text: "曲库已有 37 首，可直接播放。", tag: "37 首" });
  });
});

function realCardMarkup(): string {
  const html = readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
  const start = html.indexOf('<article class="plugin-card plugin-card--sub" id="music-platform-local"');
  expect(start, "index.html 里找不到 music-platform-local 卡片").toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</article>", start) + "</article>".length);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function api(over: Record<string, unknown> = {}) {
  return {
    getCachedTracks: vi.fn(async () => ({ ok: true, data: [{ id: "local-a" }, { id: "local-b" }] })),
    importLocalFolder: vi.fn(async () => ({ ok: true, data: { imported: 9, skipped: 1 } })),
    importLocalTracks: vi.fn(async () => ({ ok: true, data: { imported: 1, skipped: 0 } })),
    openPlayer: vi.fn(async () => undefined),
    ...over,
  };
}

beforeEach(() => {
  document.body.innerHTML = realCardMarkup();
  getMusicApiMock.mockReset();
});
afterEach(() => { document.body.innerHTML = ""; });

describe("本地音乐卡片接线", () => {
  it("初始化后显示曲库数量", async () => {
    const a = api();
    getMusicApiMock.mockReturnValue(a);
    initLocalMusicPanel();
    await flush();

    expect(a.getCachedTracks).toHaveBeenCalled();
    expect(document.getElementById("local-status-line")!.textContent).toContain("2 首");
    expect(document.getElementById("local-tag")!.textContent).toBe("2 首");
  });

  it("导入文件夹按钮触发 importLocalFolder 并回报结果", async () => {
    const a = api();
    getMusicApiMock.mockReturnValue(a);
    initLocalMusicPanel();
    await flush();

    (document.getElementById("local-import-folder") as HTMLElement).click();
    await flush();

    expect(a.importLocalFolder).toHaveBeenCalled();
    expect(document.getElementById("local-status-line")!.textContent).toContain("导入 9 首");
  });

  it("导入文件按钮走的是另一个入口", async () => {
    const a = api();
    getMusicApiMock.mockReturnValue(a);
    initLocalMusicPanel();
    await flush();

    (document.getElementById("local-import-files") as HTMLElement).click();
    await flush();

    expect(a.importLocalTracks).toHaveBeenCalled();
    expect(a.importLocalFolder).not.toHaveBeenCalled();
  });

  it("打开播放器不再需要先进网易云详情页", async () => {
    const a = api();
    getMusicApiMock.mockReturnValue(a);
    initLocalMusicPanel();
    await flush();

    (document.getElementById("local-open-player") as HTMLElement).click();
    await flush();

    expect(a.openPlayer).toHaveBeenCalled();
  });

  it("重复初始化不会重复绑定", async () => {
    const a = api();
    getMusicApiMock.mockReturnValue(a);
    initLocalMusicPanel();
    initLocalMusicPanel();
    await flush();

    expect(a.getCachedTracks).toHaveBeenCalledTimes(1);
  });
});

describe("导入的失败路径", () => {
  it("IPC 返回 ok:false → 显示失败而不是「没找到」", async () => {
    const a = api({ importLocalFolder: vi.fn(async () => ({ ok: false, errorCode: "E_INTERNAL_ERROR" })) });
    getMusicApiMock.mockReturnValue(a);
    initLocalMusicPanel();
    await flush();

    (document.getElementById("local-import-folder") as HTMLElement).click();
    await flush();

    expect(document.getElementById("local-status-line")!.textContent).toContain("失败");
  });

  it("IPC 抛异常时状态行不会卡在「正在扫描…」", async () => {
    const a = api({ importLocalFolder: vi.fn(async () => { throw new Error("ipc boom"); }) });
    getMusicApiMock.mockReturnValue(a);
    initLocalMusicPanel();
    await flush();

    (document.getElementById("local-import-folder") as HTMLElement).click();
    await flush();
    await flush();

    const text = document.getElementById("local-status-line")!.textContent ?? "";
    expect(text).not.toContain("正在扫描");
    expect(text).toContain("失败");
  });
});
