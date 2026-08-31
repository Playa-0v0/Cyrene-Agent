import { describe, it, expect } from "vitest";
import { enhanceMiniMaxText } from "./minimax-vocal-enhancer";

describe("enhanceMiniMaxText", () => {
  it("未启用时返回原文", () => {
    const text = "哈哈哈今天天气真好";
    expect(enhanceMiniMaxText(text, { enabled: false })).toBe(text);
    expect(enhanceMiniMaxText(text, null as unknown as { enabled: boolean })).toBe(text);
  });

  it("笑声类在词后插入标签", () => {
    expect(enhanceMiniMaxText("哈哈哈", { enabled: true })).toBe("哈哈哈(laughs)");
    expect(enhanceMiniMaxText("嘿嘿", { enabled: true })).toBe("嘿嘿(chuckle)");
  });

  it("迟疑类在词前插入标签", () => {
    expect(enhanceMiniMaxText("嗯，我觉得可以", { enabled: true })).toBe("(emm)嗯，我觉得可以");
    expect(enhanceMiniMaxText("emmm...这个嘛", { enabled: true })).toBe("(emm)emmm...这个嘛");
  });

  it("惊讶类在词前插入标签", () => {
    expect(enhanceMiniMaxText("啊，真的吗", { enabled: true })).toBe("(gasps)啊，真的吗");
  });

  it("叹息类在词前插入标签", () => {
    expect(enhanceMiniMaxText("唉，没办法", { enabled: true })).toBe("(sighs)唉，没办法");
    expect(enhanceMiniMaxText("哎，算了", { enabled: true })).toBe("(sighs)哎，算了");
  });

  it("代码块引导语末尾插入换气", () => {
    expect(enhanceMiniMaxText("请看下面的代码块：", { enabled: true })).toBe(
      "请看下面的代码块：(breath)",
    );
    expect(enhanceMiniMaxText("代码如下", { enabled: true })).toBe("代码如下(breath)");
  });

  it("句末省略号插入叹息", () => {
    expect(enhanceMiniMaxText("我也不知道……", { enabled: true })).toBe("我也不知道……(sighs)");
    expect(enhanceMiniMaxText("就这样吧...", { enabled: true })).toBe("就这样吧...(sighs)");
  });

  it("单段最多插入 2 处标签", () => {
    const text = "哈哈哈，嗯，好吧，唉";
    const result = enhanceMiniMaxText(text, { enabled: true });
    const tagCount = (result.match(/\([a-z-]+\)/g) ?? []).length;
    expect(tagCount).toBeLessThanOrEqual(2);
  });

  it("已有标签附近不重复插入", () => {
    const text = "哈哈哈(laughs)，嘿嘿";
    const result = enhanceMiniMaxText(text, { enabled: true });
    // 嘿嘿前已有 laughs，不应再插入 chuckle（或至多只在嘿嘿后插一个）
    const tagCount = (result.match(/\(laughs\)|\(chuckle\)/g) ?? []).length;
    expect(tagCount).toBeLessThanOrEqual(2);
  });

  it("不改变没有触发词的文本", () => {
    const text = "今天天气不错，我们去公园吧。";
    expect(enhanceMiniMaxText(text, { enabled: true })).toBe(text);
  });
});
