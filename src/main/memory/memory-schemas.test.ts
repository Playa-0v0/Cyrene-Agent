import { describe, expect, test } from "vitest";
import {
  parseMemoryJudgeResult,
  validateMemoryJudgeBusiness,
  isValidSlug,
  isValidSourceQuote,
} from "./memory-schemas";

describe("Memory Judge structured output schema", () => {
  test("accepts the B-tier JSON Object envelope", () => {
    expect(parseMemoryJudgeResult({
      candidates: [{
        layer: "L1",
        content: "用户正在迁移 React Chat 窗口",
        confidence: 0.9,
        triggerText: "我正在前端 chat 窗口迁移 react",
      }],
    })).toEqual({
      candidates: [{
        layer: "L1",
        content: "用户正在迁移 React Chat 窗口",
        confidence: 0.9,
        triggerText: "我正在前端 chat 窗口迁移 react",
      }],
      entities: [],
    });
  });

  test("treats an empty candidates envelope as a successful no-op", () => {
    const result = parseMemoryJudgeResult({ candidates: [] });

    expect(validateMemoryJudgeBusiness(result)).toEqual({
      status: "accepted",
      value: { candidates: [], entities: [] },
    });
  });

  test("parses entities alongside candidates and rejects bad types", () => {
    const result = parseMemoryJudgeResult({
      candidates: [],
      entities: [
        { name: "小张", type: "person", aliases: ["张三"] },
        { name: "北京", type: "place" },
      ],
    });

    expect(result.entities).toEqual([
      { name: "小张", type: "person", aliases: ["张三"] },
      { name: "北京", type: "place" },
    ]);

    expect(() => parseMemoryJudgeResult({
      candidates: [],
      entities: [{ name: "X", type: "unknown_type" }],
    })).toThrow();
  });

  test("parses slug for L2 candidates and trims whitespace", () => {
    const result = parseMemoryJudgeResult({
      candidates: [{
        layer: "L2",
        content: "用户喜欢香菇",
        confidence: 0.9,
        triggerText: "我喜欢香菇",
        slug: "  喜欢香菇  ",
      }],
      entities: [],
    });

    expect(result.candidates[0].slug).toBe("喜欢香菇");
  });

  test("drops invalid slug silently instead of failing the whole candidate", () => {
    // 含标点 → 非法，丢弃 slug，候选照常通过
    const withPunct = parseMemoryJudgeResult({
      candidates: [{
        layer: "L2",
        content: "用户喜欢香菇",
        confidence: 0.9,
        triggerText: "我喜欢香菇",
        slug: "喜欢香菇，很爱吃",
      }],
      entities: [],
    });
    expect(withPunct.candidates[0].slug).toBeUndefined();

    // 含 emoji → 非法
    const withEmoji = parseMemoryJudgeResult({
      candidates: [{
        layer: "L2",
        content: "用户喜欢香菇",
        confidence: 0.9,
        triggerText: "我喜欢香菇",
        slug: "喜欢香菇🍄",
      }],
      entities: [],
    });
    expect(withEmoji.candidates[0].slug).toBeUndefined();

    // 超长（>20）→ 非法
    const tooLong = parseMemoryJudgeResult({
      candidates: [{
        layer: "L2",
        content: "用户喜欢香菇",
        confidence: 0.9,
        triggerText: "我喜欢香菇",
        slug: "一二三四五六七八九十一二三四五六七八九十一",
      }],
      entities: [],
    });
    expect(tooLong.candidates[0].slug).toBeUndefined();
  });

  test("ignores slug on L0/L1 candidates even if LLM emits it", () => {
    const result = parseMemoryJudgeResult({
      candidates: [{
        layer: "L1",
        field: "recentPreferences",
        content: "近期偏好深色主题",
        confidence: 0.8,
        triggerText: "我最近偏好深色主题",
        slug: "深色偏好",
      }],
      entities: [],
    });

    expect(result.candidates[0].slug).toBeUndefined();
  });

  test("parses sourceQuote for L2 candidates and trims whitespace", () => {
    const result = parseMemoryJudgeResult({
      candidates: [{
        layer: "L2",
        content: "用户用 React 18.2 做前端",
        confidence: 0.9,
        triggerText: "我用 React 18.2 做的前端",
        sourceQuote: "  我用 React 18.2 做的前端，部署在 vercel 上  ",
      }],
      entities: [],
    });

    expect(result.candidates[0].sourceQuote).toBe("我用 React 18.2 做的前端，部署在 vercel 上");
  });

  test("sourceQuote allows punctuation, spaces, emoji (it is verbatim dialogue)", () => {
    const result = parseMemoryJudgeResult({
      candidates: [{
        layer: "L2",
        content: "用户喜欢香菇",
        confidence: 0.9,
        triggerText: "我喜欢香菇",
        sourceQuote: "我喜欢香菇，很爱吃！🍄",
      }],
      entities: [],
    });

    expect(result.candidates[0].sourceQuote).toBe("我喜欢香菇，很爱吃！🍄");
  });

  test("drops over-length sourceQuote silently instead of failing the whole candidate", () => {
    // 501 字 → 超过 500 上限，丢弃 sourceQuote，候选照常通过
    const tooLong = "x".repeat(501);
    const result = parseMemoryJudgeResult({
      candidates: [{
        layer: "L2",
        content: "用户喜欢香菇",
        confidence: 0.9,
        triggerText: "我喜欢香菇",
        sourceQuote: tooLong,
      }],
      entities: [],
    });
    expect(result.candidates[0].sourceQuote).toBeUndefined();
    // 候选本身仍然入库
    expect(result.candidates[0].content).toBe("用户喜欢香菇");
  });

  test("accepts sourceQuote at exactly 500 chars (boundary)", () => {
    const exact = "x".repeat(500);
    const result = parseMemoryJudgeResult({
      candidates: [{
        layer: "L2",
        content: "用户喜欢香菇",
        confidence: 0.9,
        triggerText: "我喜欢香菇",
        sourceQuote: exact,
      }],
      entities: [],
    });
    expect(result.candidates[0].sourceQuote).toBe(exact);
  });

  test("drops empty/whitespace-only sourceQuote silently", () => {
    const result = parseMemoryJudgeResult({
      candidates: [{
        layer: "L2",
        content: "用户喜欢香菇",
        confidence: 0.9,
        triggerText: "我喜欢香菇",
        sourceQuote: "   ",
      }],
      entities: [],
    });
    expect(result.candidates[0].sourceQuote).toBeUndefined();
  });

  test("ignores sourceQuote on L0/L1 candidates even if LLM emits it", () => {
    const result = parseMemoryJudgeResult({
      candidates: [{
        layer: "L1",
        field: "recentPreferences",
        content: "近期偏好深色主题",
        confidence: 0.8,
        triggerText: "我最近偏好深色主题",
        sourceQuote: "我最近偏好深色主题",
      }],
      entities: [],
    });

    expect(result.candidates[0].sourceQuote).toBeUndefined();
  });
});

describe("isValidSourceQuote", () => {
  test("accepts non-empty strings up to 500 chars", () => {
    expect(isValidSourceQuote("我喜欢香菇")).toBe(true);
    expect(isValidSourceQuote("我用 React 18.2 做的前端，部署在 vercel 上")).toBe(true);
    expect(isValidSourceQuote("喜欢香菇，很爱吃！🍄")).toBe(true);
    expect(isValidSourceQuote("x".repeat(500))).toBe(true);
  });

  test("rejects empty, whitespace-only, and over-length", () => {
    expect(isValidSourceQuote("")).toBe(false);
    expect(isValidSourceQuote("   ")).toBe(false);
    expect(isValidSourceQuote("x".repeat(501))).toBe(false);
  });

  test("rejects non-string inputs", () => {
    expect(isValidSourceQuote(undefined)).toBe(false);
    expect(isValidSourceQuote(null)).toBe(false);
    expect(isValidSourceQuote(123)).toBe(false);
  });
});

describe("isValidSlug", () => {
  test("accepts Chinese, letters, digits, underscore, hyphen", () => {
    expect(isValidSlug("喜欢香菇")).toBe(true);
    expect(isValidSlug("和小张约饭")).toBe(true);
    expect(isValidSlug("ReactChat迁移")).toBe(true);
    expect(isValidSlug("react_chat-migration")).toBe(true);
    expect(isValidSlug("片段_2026")).toBe(true);
  });

  test("rejects empty, whitespace-only, and over-length", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("   ")).toBe(false);
    expect(isValidSlug("一二三四五六七八九十一二三四五六七八九十一")).toBe(false);
  });

  test("rejects punctuation, quotes, spaces, emoji", () => {
    expect(isValidSlug("喜欢香菇，很爱吃")).toBe(false);
    expect(isValidSlug("喜欢 香菇")).toBe(false);
    expect(isValidSlug("喜欢「香菇」")).toBe(false);
    expect(isValidSlug("喜欢香菇🍄")).toBe(false);
    expect(isValidSlug("喜欢/香菇")).toBe(false);
  });

  test("rejects non-string inputs", () => {
    expect(isValidSlug(undefined)).toBe(false);
    expect(isValidSlug(null)).toBe(false);
    expect(isValidSlug(123)).toBe(false);
  });
});
