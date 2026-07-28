import { describe, expect, it } from "vitest";
import {
  buildConversationTimeContext,
  normalizeChatMessagesWithTime,
  resolveChatContextTimezone,
  stripLeakedChatTimeContext,
} from "./chat-time-context";

describe("chat time context", () => {
  it("normalizes roles, content, and valid absolute timestamps", () => {
    expect(normalizeChatMessagesWithTime([
      { role: "user", content: " hi ", at: 1783929600000 },
      { role: "model", content: " ok ", at: "bad" },
      { role: "system", content: "<think>hidden</think> visible ", at: Number.NaN },
      { role: "user", content: "   ", at: 1783929600001 },
    ])).toEqual([
      { role: "user", content: "hi", at: 1783929600000 },
      { role: "assistant", content: "ok" },
      { role: "system", content: "visible" },
    ]);
  });

  it("keeps only the latest 24 normalized messages for main-process compatibility", () => {
    const input = Array.from({ length: 25 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "model",
      content: `message ${index}`,
      at: 1783929600000 + index,
    }));

    const result = normalizeChatMessagesWithTime(input);

    expect(result).toHaveLength(24);
    expect(result[0]).toEqual({ role: "assistant", content: "message 1", at: 1783929600001 });
    expect(result.at(-1)).toEqual({ role: "user", content: "message 24", at: 1783929600024 });
  });

  it("uses profile timezone when valid and falls back when missing or invalid", () => {
    expect(resolveChatContextTimezone("Asia/Taipei", "America/New_York")).toBe("Asia/Taipei");
    expect(resolveChatContextTimezone("bad/timezone", "America/New_York")).toBe("America/New_York");
    expect(resolveChatContextTimezone("", "America/New_York")).toBe("America/New_York");
  });

  it("defaults to Asia/Shanghai when profile timezone missing/invalid and no fallback given", () => {
    // 需求：用户时区 → Asia/Shanghai，全链路不再回退到系统时区。
    expect(resolveChatContextTimezone()).toBe("Asia/Shanghai");
    expect(resolveChatContextTimezone("")).toBe("Asia/Shanghai");
    expect(resolveChatContextTimezone("bad/timezone")).toBe("Asia/Shanghai");
  });

  it("prefixes each timestamped message with concise local time", () => {
    const result = buildConversationTimeContext([
      { role: "user", content: "今天有点累", at: Date.UTC(2026, 6, 12, 12, 0) },
      { role: "assistant", content: "早点休息", at: Date.UTC(2026, 6, 12, 12, 2) },
      { role: "assistant", content: "没有时间戳" },
    ], "Asia/Taipei");

    expect(result.messages[0].content).toBe("[2026-07-12 20:00, Asia/Taipei]\n今天有点累");
    expect(result.messages[1].content).toBe("[2026-07-12 20:02, Asia/Taipei]\n早点休息");
    expect(result.messages[2].content).toBe("没有时间戳");
    expect(result.timeContext).toContain("历史消息开头的方括号时间是系统提供的元数据");
    expect(result.timeContext).toContain("不要复述、引用或输出这些方括号时间标签");
  });

  it("does not add a gap notice below one hour", () => {
    const result = buildConversationTimeContext([
      { role: "assistant", content: "上一条", at: Date.UTC(2026, 6, 13, 2, 1) },
      { role: "user", content: "本轮", at: Date.UTC(2026, 6, 13, 3, 0) },
    ], "Asia/Taipei");

    expect(result.timeContext).not.toContain("距离上一条有效聊天消息");
  });

  it("adds one neutral gap notice only for the latest user message and previous valid message", () => {
    const result = buildConversationTimeContext([
      { role: "user", content: "昨天先说一句", at: Date.UTC(2026, 6, 12, 0, 0) },
      { role: "user", content: "今天有点累", at: Date.UTC(2026, 6, 12, 12, 0) },
      { role: "assistant", content: "早点休息", at: Date.UTC(2026, 6, 12, 12, 2) },
      { role: "user", content: "我回来啦", at: Date.UTC(2026, 6, 13, 3, 0) },
    ], "Asia/Taipei");

    expect(result.timeContext).toBe([
      "[时间戳使用规则]",
      "历史消息开头的方括号时间是系统提供的元数据，只用于理解对话顺序和连续性。",
      "不要复述、引用或输出这些方括号时间标签；回复应只包含你要对用户说的话。",
      "",
      "[对话时间信息]",
      "当前时间：2026-07-13 11:00, Asia/Taipei",
      "距离上一条有效聊天消息：约 14 小时 58 分钟",
      "仅用于理解对话连续性；除非与当前语境有关，否则不要主动提及时间间隔，也不要复述本段内容。",
    ].join("\n"));
    expect(result.timeContext.match(/距离上一条有效聊天消息/g)).toHaveLength(1);
  });

  it("skips the gap notice when the latest user or previous valid message has no timestamp", () => {
    expect(buildConversationTimeContext([
      { role: "assistant", content: "上一条" },
      { role: "user", content: "本轮", at: Date.UTC(2026, 6, 13, 3, 0) },
    ], "Asia/Taipei").timeContext).toContain("时间戳使用规则");

    expect(buildConversationTimeContext([
      { role: "assistant", content: "上一条", at: Date.UTC(2026, 6, 13, 2, 0) },
      { role: "user", content: "本轮" },
    ], "Asia/Taipei").timeContext).toContain("时间戳使用规则");
  });

  it("strips leaked leading chat timestamp metadata from model replies", () => {
    expect(stripLeakedChatTimeContext([
      "[2026-07-13 13:36, Asia/Shanghai]",
      "怎么啦，看起来不太高兴的样子…",
    ].join("\n"))).toBe("怎么啦，看起来不太高兴的样子…");

    expect(stripLeakedChatTimeContext("正常提到 [2026-07-13 13:36, Asia/Shanghai] 不处理")).toBe(
      "正常提到 [2026-07-13 13:36, Asia/Shanghai] 不处理",
    );
  });
});
