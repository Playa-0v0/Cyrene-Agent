// moment-media-matcher 契约测试：配图查询构建（清洗 + 时间上下文 + 截断）与
// 贴图 id → 媒体引用解析（内置贴图 / 用户贴图 / 未知 id 降级）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { manifest } = vi.hoisted(() => ({
  manifest: { current: {} as Record<string, { file: string }> },
}));

// sticker-storage 引 electron（app.getPath），测试环境直接 mock 掉
vi.mock("../sticker-storage", () => ({
  loadUserStickerManifest: () => manifest.current,
}));

import { buildMomentImageQuery, resolveMomentStickerMedia } from "./moment-media-matcher";

describe("buildMomentImageQuery", () => {
  it("拼接动态文案、触发摘录与时间上下文", () => {
    const query = buildMomentImageQuery(
      "深夜赶工结束啦",
      "[23:30] 用户：修完了",
      new Date("2026-09-04T23:30:00"),
    );

    expect(query).toContain("深夜赶工结束啦");
    expect(query).toContain("修完了");
    expect(query).toContain("深夜");
  });

  it("代码块被清洗剔除，只保留自然语言", () => {
    const query = buildMomentImageQuery(
      "```js\nconst a = 1\n```\n终于修好了",
      "",
      new Date("2026-09-04T12:00:00"),
    );

    expect(query).toContain("终于修好了");
    expect(query).not.toContain("const a = 1");
  });

  it("超出 maxLength 时截断", () => {
    const query = buildMomentImageQuery(
      "很长的文案".repeat(50),
      "",
      new Date("2026-09-04T12:00:00"),
      10,
    );

    expect(query.length).toBeLessThanOrEqual(10);
  });
});

describe("resolveMomentStickerMedia", () => {
  beforeEach(() => {
    manifest.current = {};
  });

  it("内置贴图解析为 public 相对路径（渲染端 resolveAsset 消费）", () => {
    expect(resolveMomentStickerMedia("sleepynow")).toEqual({
      id: "media_sticker_sleepynow",
      type: "image",
      origin: "character_asset",
      ref: "stickers/sleepynow.jpg",
    });
  });

  it("用户贴图解析为 local-sticker:// 完整 URL", () => {
    manifest.current = { "my-cat": { file: "my-cat.png" } };

    expect(resolveMomentStickerMedia("my-cat")).toEqual({
      id: "media_sticker_my-cat",
      type: "image",
      origin: "character_asset",
      ref: "local-sticker:///my-cat.png",
    });
  });

  it("未知 id（贴图已删除）返回 null 降级纯文字", () => {
    expect(resolveMomentStickerMedia("ghost-sticker")).toBeNull();
  });
});