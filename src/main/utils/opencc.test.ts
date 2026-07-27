import { describe, expect, it } from "vitest";
import { toTraditionalTaiwan } from "./opencc";

describe("toTraditionalTaiwan", () => {
  it("converts Simplified Chinese and common Taiwan terminology", () => {
    expect(toTraditionalTaiwan("这个视频支持计算机音频和屏幕显示"))
      .toBe("這個影片支援電腦音訊和螢幕顯示");
  });

  it("keeps URLs and non-Chinese text unchanged", () => {
    expect(toTraditionalTaiwan("https://www.bilibili.com/video/BV1TEST p01 Remix"))
      .toBe("https://www.bilibili.com/video/BV1TEST p01 Remix");
  });

  it("fully converges phrases that require more than one OpenCC pass", () => {
    const converted = toTraditionalTaiwan("死灭回游");
    expect(converted).toBe("死滅迴遊");
    expect(toTraditionalTaiwan(converted)).toBe(converted);
  });
});
