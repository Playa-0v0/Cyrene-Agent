import { describe, expect, it } from "vitest";
import {
  getAssistantReplyBubbleTexts,
  segmentAssistantReply,
  shouldBreakStreamingBubbleAfterChar,
  shouldSkipStreamingBubbleLeadingChar,
  shouldSegmentAssistantReply,
} from "./message-segmentation";

describe("message segmentation", () => {
  it("keeps short natural chat bubbles intact", () => {
    const text = "噗…好好好，是帅气！但人家眼里，又帅又可爱的样子，不是更犯规吗…真的好难抵挡呢♪";
    expect(segmentAssistantReply(text)).toEqual([text]);
  });

  it("splits compact multi-sentence casual replies", () => {
    const text = "今天天气挺凉快的呢，淄博那边下雨了吗？开发辛苦了，记得多起来动一动哦。你中午吃的什么呀？最近有什么好玩的事想分享吗？要喝点水啦，别光顾着忙。";

    const parts = segmentAssistantReply(text);

    expect(parts).toEqual([
      "今天天气挺凉快的呢，淄博那边下雨了吗？",
      "开发辛苦了，记得多起来动一动哦。",
      "你中午吃的什么呀？最近有什么好玩的事想分享吗？",
      "要喝点水啦，别光顾着忙。",
    ]);
    expect(parts.join("")).toBe(text);
  });

  it("uses sentence-ending punctuation as streaming bubble boundaries", () => {
    expect(shouldBreakStreamingBubbleAfterChar("。")).toBe(true);
    expect(shouldBreakStreamingBubbleAfterChar("？")).toBe(true);
    expect(shouldBreakStreamingBubbleAfterChar("?")).toBe(true);
    expect(shouldBreakStreamingBubbleAfterChar("！")).toBe(true);
    expect(shouldBreakStreamingBubbleAfterChar("!")).toBe(true);
    expect(shouldBreakStreamingBubbleAfterChar("；")).toBe(true);
    expect(shouldBreakStreamingBubbleAfterChar(";")).toBe(true);
    expect(shouldBreakStreamingBubbleAfterChar("，")).toBe(false);
  });

  it("skips whitespace at the start of a streaming bubble", () => {
    expect(shouldSkipStreamingBubbleLeadingChar("\n", true)).toBe(true);
    expect(shouldSkipStreamingBubbleLeadingChar("\r", true)).toBe(true);
    expect(shouldSkipStreamingBubbleLeadingChar(" ", true)).toBe(true);
    expect(shouldSkipStreamingBubbleLeadingChar("中", true)).toBe(false);
    expect(shouldSkipStreamingBubbleLeadingChar("\n", false)).toBe(false);
  });

  it("splits medium natural chat into two readable bubbles", () => {
    const text = [
      "我知道啦，今天你其实已经撑得很久了，不是没有努力。",
      "先别急着把所有事情都补完，能把最重要的一件收尾，就已经很值得夸了。",
      "剩下的我们慢慢拆开，我陪你一件一件处理。",
      "如果中途觉得累，就先停一下，不需要一次把状态拉满。"
    ].join("");

    const parts = segmentAssistantReply(text);

    expect(parts).toHaveLength(2);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => part.length >= 35)).toBe(true);
  });

  it("caps long chat replies at ten bubbles", () => {
    const text = "今天先不用把自己逼得太紧，我们可以从最小的一步开始。".repeat(12);
    const parts = segmentAssistantReply(text);

    expect(parts.length).toBeLessThanOrEqual(10);
    expect(parts.length).toBeGreaterThan(4);
    expect(parts.join("")).toBe(text);
  });

  it("does not split structured content", () => {
    expect(segmentAssistantReply("```ts\nconst a = 1;\n```\n这段不要拆。")).toHaveLength(1);
    expect(segmentAssistantReply("- 第一项\n- 第二项\n- 第三项\n这段也不要拆。")).toHaveLength(1);
    expect(segmentAssistantReply("| A | B |\n|---|---|\n| 1 | 2 |")).toHaveLength(1);
  });

  it("applies preference by current chat mode", () => {
    expect(shouldSegmentAssistantReply("chat", "chat")).toBe(true);
    expect(shouldSegmentAssistantReply("work", "chat")).toBe(false);
    expect(shouldSegmentAssistantReply("work", "all")).toBe(true);
    expect(shouldSegmentAssistantReply("chat", "off")).toBe(false);
  });

  it("keeps one empty assistant bubble only while streaming", () => {
    expect(getAssistantReplyBubbleTexts("", "chat", "all")).toEqual([]);
    expect(getAssistantReplyBubbleTexts("", "chat", "all", { preserveEmpty: true })).toEqual([""]);
  });
});
