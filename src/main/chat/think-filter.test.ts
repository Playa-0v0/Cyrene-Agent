/**
 * think-filter 单元测试
 *
 * 覆盖 GPT 建议的 12 条测试场景中的核心路径。
 */

import { describe, expect, test } from "vitest";
import { createThinkFilter, stripThinkBlocks, type ThinkFilterMode } from "./think-filter";

/** 辅助：把字符串拆成单字符 chunk 喂给 filter，模拟流式 */
function feedByChar(filter: ReturnType<typeof createThinkFilter>, text: string): string {
  let result = "";
  for (const char of text) {
    result += filter.push(char);
  }
  result += filter.flush();
  return result;
}

/** 辅助：把字符串按指定大小拆 chunk */
function feedByChunks(filter: ReturnType<typeof createThinkFilter>, text: string, chunkSize: number): string {
  let result = "";
  for (let i = 0; i < text.length; i += chunkSize) {
    result += filter.push(text.slice(i, i + chunkSize));
  }
  result += filter.flush();
  return result;
}

describe("think-filter - leading-only mode (默认)", () => {
  const mode: ThinkFilterMode = "leading-only";

  test("消息以 <think> 开头：过滤 think 块，保留后续正文", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "<think>这是思考</think>这是回答");
    expect(result).toBe("这是回答");
  });

  test("逐块捕获公开 think 文本，同时保持正文分离", () => {
    const filter = createThinkFilter(mode);
    let visible = filter.push("<thi");
    expect(filter.takeThinking()).toBe("");
    visible += filter.push("nk>先分析");
    const firstThinking = filter.takeThinking();
    visible += filter.push("问题</think>回答");
    const secondThinking = filter.takeThinking();
    visible += filter.flush();
    expect(firstThinking + secondThinking).toBe("先分析问题");
    expect(visible).toBe("回答");
  });

  test("消息不以 <think> 开头：原样透传", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "这是普通回答");
    expect(result).toBe("这是普通回答");
  });

  test("正文讨论 <think> 标签时不误删", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "这个模型会输出 `<think>...</think>` 标签。");
    expect(result).toBe("这个模型会输出 `<think>...</think>` 标签。");
  });

  test("消息以空白 + <think> 开头：仍过滤（保留前导空白）", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "\n\n<think>思考</think>回答");
    expect(result).toBe("\n\n回答");
  });

  test("多个 <think> 块（开头模式触发后全部过滤）", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "<think>思考1</think>回答1<think>思考2</think>回答2");
    expect(result).toBe("回答1回答2");
  });

  test("跨 chunk 拆分 <think> 标签", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChunks(filter, "<think>思考</think>回答", 3);
    expect(result).toBe("回答");
  });

  test("逐字符拆分 <think> 标签", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "<think>abc</think>def");
    expect(result).toBe("def");
  });

  test("同一 chunk 同时包含思考和回答", () => {
    const filter = createThinkFilter(mode);
    const pushed = filter.push("<think>思考</think>回答");
    const flushed = filter.flush();
    expect(pushed + flushed).toBe("回答");
  });

  test("<think> 没有正常闭合：丢弃后续内容", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "<think>未闭合的思考");
    expect(result).toBe("");
  });

  test("空消息", () => {
    const filter = createThinkFilter(mode);
    expect(filter.push("")).toBe("");
    expect(filter.flush()).toBe("");
  });

  test("纯空白消息", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "   \n\n  ");
    expect(result).toBe("   \n\n  ");
  });

  test("以 < 但不是 <think> 开头：原样透传", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "<div>hello</div>");
    expect(result).toBe("<div>hello</div>");
  });
});

describe("think-filter - strict mode", () => {
  const mode: ThinkFilterMode = "strict";

  test("过滤全文所有 <think> 块", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "前面<think>思考</think>中间<think>更多</think>后面");
    expect(result).toBe("前面中间后面");
  });

  test("不以 <think> 开头也过滤", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "回答<think>思考</think>");
    expect(result).toBe("回答");
  });

  test("正文讨论 <think> 标签时也会被过滤（strict 特性）", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "这个模型会输出 <think>xxx</think> 标签");
    expect(result).toBe("这个模型会输出  标签");
  });
});

describe("think-filter - disabled mode", () => {
  const mode: ThinkFilterMode = "disabled";

  test("原样透传", () => {
    const filter = createThinkFilter(mode);
    const result = feedByChar(filter, "<think>思考</think>回答");
    expect(result).toBe("<think>思考</think>回答");
  });
});

describe("think-filter - FC 循环场景", () => {
  test("模拟两次 LLM 调用：第一次 think 未闭合不影响第二次", () => {
    // 第一次消息（未闭合 think）
    const filter1 = createThinkFilter("leading-only");
    const result1 = feedByChar(filter1, "<think>我要调用工具");
    expect(result1).toBe(""); // think 内容被过滤

    // 第二次消息（新的 filter，独立状态）
    const filter2 = createThinkFilter("leading-only");
    const result2 = feedByChar(filter2, "已经向网易云发送播放请求。");
    expect(result2).toBe("已经向网易云发送播放请求。");
  });

  test("工具调用后第二次输出仍能正常显示", () => {
    const filter = createThinkFilter("leading-only");
    // 第一次 LLM 输出
    const r1 = filter.push("<think>调用工具</think>");
    filter.flush();
    // 模拟新的 TEXT_MESSAGE_START 创建新 filter
    const filter2 = createThinkFilter("leading-only");
    const r2 = feedByChar(filter2, "工具执行完成，这是最终回答。");
    expect(r2).toBe("工具执行完成，这是最终回答。");
  });
});

describe("think-filter - 边界情况", () => {
  test("空 delta 不产生输出", () => {
    const filter = createThinkFilter("leading-only");
    expect(filter.push("")).toBe("");
    expect(filter.push("")).toBe("");
  });

  test("flush 在 passthrough 态返回空", () => {
    const filter = createThinkFilter("leading-only");
    filter.push("普通文本");
    expect(filter.flush()).toBe("");
  });

  test("flush 在 buffering 态返回全部缓冲", () => {
    const filter = createThinkFilter("leading-only");
    filter.push("<thi"); // 不够 7 字符，还在 buffering
    const result = filter.flush();
    expect(result).toBe("<thi");
  });

  test("大小写不敏感", () => {
    const filter = createThinkFilter("leading-only");
    const result = feedByChar(filter, "<THINK>思考</THINK>回答");
    expect(result).toBe("回答");
  });
});

describe("stripThinkBlocks (非流式)", () => {
  test("剥离闭合的 think 块", () => {
    expect(stripThinkBlocks("<think>思考</think>回答")).toBe("回答");
  });

  test("剥离未闭合的 think 块", () => {
    expect(stripThinkBlocks("<think>未闭合")).toBe("");
  });

  test("多个 think 块", () => {
    expect(stripThinkBlocks("a<think>x</think>b<think>y</think>c")).toBe("abc");
  });

  test("无 think 块", () => {
    expect(stripThinkBlocks("普通文本")).toBe("普通文本");
  });

  test("大小写不敏感", () => {
    expect(stripThinkBlocks("<Think>x</Think>y")).toBe("y");
  });
});
