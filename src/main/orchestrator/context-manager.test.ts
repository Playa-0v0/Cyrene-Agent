import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimateMessageContentTokens,
  estimateMessageTokens,
} from "./context-manager";

describe("estimateMessageContentTokens — 图片块计量口径（known-issues 问题 2）", () => {
  it("字符串内容按文本估算", () => {
    expect(estimateMessageContentTokens("你好")).toBeGreaterThan(0);
  });

  it("空块数组返回 0", () => {
    expect(estimateMessageContentTokens([])).toBe(0);
  });

  it("text 块按文本估算，与字符串口径一致", () => {
    const text = "一段普通文本";
    expect(estimateMessageContentTokens([{ type: "text", text }]))
      .toBe(estimateMessageContentTokens(text));
  });

  it("image_url 块按固定值估算，不计 base64 全长", () => {
    const hugeBase64 = `data:image/png;base64,${"A".repeat(1_000_000)}`;
    const tokens = estimateMessageContentTokens([
      { type: "image_url", image_url: { url: hugeBase64 } },
    ]);
    // 虚高修复前：base64 长度会被整串计入（百万字符 → 数十万 token）。
    expect(tokens).toBe(DEFAULT_IMAGE_TOKEN_ESTIMATE);
  });

  it("混合块 = 文本估算 + 图片固定值", () => {
    const text = "看这张图";
    const tokens = estimateMessageContentTokens([
      { type: "text", text },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]);
    expect(tokens).toBe(estimateMessageContentTokens(text) + DEFAULT_IMAGE_TOKEN_ESTIMATE);
  });

  it("多图消息按图片张数线性累计", () => {
    const tokens = estimateMessageContentTokens([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
    ]);
    expect(tokens).toBe(DEFAULT_IMAGE_TOKEN_ESTIMATE * 2);
  });
});

describe("estimateMessageTokens — 消息级计量复用同一口径", () => {
  it("图片消息不因 base64 长度爆炸（角色开销 +4 之外只有固定图片估算）", () => {
    const tokens = estimateMessageTokens([
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"B".repeat(500_000)}` } }] },
    ]);
    expect(tokens).toBe(DEFAULT_IMAGE_TOKEN_ESTIMATE + 4);
  });
});
