// moment-media-matcher 契约测试：配图查询构建（清洗 + 时间上下文 + 截断）与
// 余弦匹配（阈值 / 最高分 / 描述缺失降级）。
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../rag/embedding";
import {
  buildMomentImageQuery,
  matchMomentAsset,
  type MomentAssetEmbeddingEntry,
} from "./moment-media-matcher";

/** 查询向量恒为 [1,0]：素材向量与之算余弦，方便构造精确分数。 */
function fakeProvider(): EmbeddingProvider {
  return {
    name: "test-provider",
    dims: 2,
    embed: vi.fn(async () => [1, 0]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
  };
}

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

describe("matchMomentAsset", () => {
  it("空查询不调用 provider 直接返回 null", async () => {
    const provider = fakeProvider();
    const index: MomentAssetEmbeddingEntry[] = [{ id: "desk-night-01", embedding: [1, 0] }];

    expect(await matchMomentAsset("   ", provider, index, 0.55)).toBeNull();
    expect(provider.embed).not.toHaveBeenCalled();
  });

  it("索引为空直接返回 null", async () => {
    expect(await matchMomentAsset("深夜", fakeProvider(), [], 0.55)).toBeNull();
  });

  it("余弦最高且达阈值的素材命中并带出文件名", async () => {
    const index: MomentAssetEmbeddingEntry[] = [
      { id: "night-sky-01", embedding: [0, 1] },
      { id: "desk-night-01", embedding: [1, 0] },
    ];

    const matched = await matchMomentAsset("深夜赶工", fakeProvider(), index, 0.55);

    expect(matched).toMatchObject({ id: "desk-night-01", file: "desk-night-01.jpg" });
    expect(matched?.score).toBe(1);
  });

  it("最高分低于阈值返回 null（纯文字降级）", async () => {
    const index: MomentAssetEmbeddingEntry[] = [
      { id: "desk-night-01", embedding: [0, 1] }, // 与查询向量 [1,0] 余弦为 0
    ];

    expect(await matchMomentAsset("深夜", fakeProvider(), index, 0.55)).toBeNull();
  });

  it("索引 id 不在描述表（素材已移除）时视为未命中", async () => {
    const index: MomentAssetEmbeddingEntry[] = [{ id: "ghost-01", embedding: [1, 0] }];

    expect(await matchMomentAsset("深夜", fakeProvider(), index, 0.55)).toBeNull();
  });
});