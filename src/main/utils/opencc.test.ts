import { describe, expect, it } from "vitest";
import { toTraditionalTaiwan, toSimplifiedChinese } from "./opencc";

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

describe("toSimplifiedChinese", () => {
  it("converts Traditional Chinese to Simplified Chinese and fixes polyphones", () => {
    expect(toSimplifiedChinese("我是昔漣，今天也請多指教囉！陪伴著你看著我，做什麼呢？"))
      .toBe("我是昔涟，今天也请多指教啰！陪伴着你看着我，做什么呢？");
  });
});


