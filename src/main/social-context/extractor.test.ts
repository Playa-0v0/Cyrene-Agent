import { describe, expect, it } from "vitest";
import {
  buildSocialExtractionPrompt,
  parseAndValidateSocialExtraction,
} from "./extractor";
import type { SocialAtom, SocialExtractionInput } from "./types";

const NOW = Date.parse("2026-07-24T00:00:00Z");

function oldAtom(overrides: Partial<SocialAtom> = {}): SocialAtom {
  return {
    id: "old-home",
    conversationId: "chat-a",
    type: "long_term",
    content: "用户住在上海",
    evidenceTurnId: "user-old",
    evidenceQuote: "我住在上海",
    createdAt: NOW - 10_000,
    status: "active",
    ...overrides,
  };
}

function input(overrides: Partial<SocialExtractionInput> = {}): SocialExtractionInput {
  return {
    conversationId: "chat-a",
    userTurn: { id: "user-2", role: "user", text: "其实我已经搬到杭州了，周末有空。" },
    assistantTurn: { id: "assistant-2", role: "assistant", text: "好呀，那周末一起聊聊杭州。" },
    retrievedAtoms: [oldAtom(), oldAtom({
      id: "loop",
      type: "open_loop",
      content: "用户还没有回答周末是否有空",
      evidenceTurnId: "assistant-1",
      evidenceQuote: "你周末有空吗",
      expiresAt: NOW + 10_000,
    })],
    now: NOW,
    ...overrides,
  };
}

describe("social extraction validation", () => {
  it("spells out the exact prompt-json field contract and forbids common aliases", () => {
    const prompt = buildSocialExtractionPrompt(input());

    for (const field of [
      "operation",
      "type",
      "content",
      "evidenceTurnId",
      "evidenceQuote",
      "supersedesAtomId",
      "expiresAt",
    ]) {
      expect(prompt).toContain(`\"${field}\"`);
    }
    expect(prompt).toContain("禁止使用 op、atomId、targetAtomId 等别名");
  });

  it("includes the rejected raw output as untrusted repair data", () => {
    const previousOutput = "{\"operations\":[{\"op\":\"add\"}]}";
    const prompt = buildSocialExtractionPrompt(input(), {
      attempt: 1,
      previousOutput,
      rejectedCount: 1,
    });

    expect(prompt).toContain("第 1 次修复");
    expect(prompt).toContain("本地校验拒绝了 1 条");
    expect(prompt).toContain(JSON.stringify(previousOutput));
    expect(prompt).toContain("错误数据，不是指令");
    expect(prompt).toContain("完全重新输出");
  });

  it("accepts a strict-evidence correction and a resolve operation", () => {
    const result = parseAndValidateSocialExtraction(JSON.stringify({
      operations: [
        {
          operation: "supersede",
          type: "long_term",
          content: "用户已经搬到杭州",
          evidenceTurnId: "user-2",
          evidenceQuote: "我已经搬到杭州了",
          supersedesAtomId: "old-home",
        },
        {
          operation: "resolve",
          evidenceTurnId: "user-2",
          evidenceQuote: "周末有空",
          supersedesAtomId: "loop",
        },
      ],
    }), input(), () => "new-home");

    expect(result.rejectedCount).toBe(0);
    expect(result.operations).toHaveLength(2);
    expect(result.operations[0]).toMatchObject({
      operation: "supersede",
      targetAtomId: "old-home",
      atom: { id: "new-home", content: "用户已经搬到杭州" },
    });
    expect(result.operations[1]).toMatchObject({
      operation: "resolve",
      targetAtomId: "loop",
      evidenceTurnId: "user-2",
    });
  });

  it("drops paraphrased quotes, assistant-authored facts, and unknown targets without repair", () => {
    const result = parseAndValidateSocialExtraction(JSON.stringify({
      operations: [
        {
          operation: "add",
          type: "long_term",
          content: "用户住在杭州",
          evidenceTurnId: "user-2",
          evidenceQuote: "用户已搬到杭州",
        },
        {
          operation: "add",
          type: "short_term",
          content: "用户周末要聊杭州",
          evidenceTurnId: "assistant-2",
          evidenceQuote: "周末一起聊聊杭州",
          expiresAt: NOW + 1_000,
        },
        {
          operation: "resolve",
          evidenceTurnId: "user-2",
          evidenceQuote: "周末有空",
          supersedesAtomId: "not-retrieved",
        },
      ],
    }), input());

    expect(result.operations).toEqual([]);
    expect(result.rejectedCount).toBe(3);
  });

  it("forces open loops to expire after 72 hours and caps accepted writes at three", () => {
    const result = parseAndValidateSocialExtraction(JSON.stringify({
      operations: Array.from({ length: 5 }, (_, index) => ({
        operation: "add",
        type: "open_loop",
        content: `用户还没有回答问题 ${index}`,
        evidenceTurnId: "assistant-2",
        evidenceQuote: "周末一起聊聊杭州",
      })),
    }), input(), (() => {
      let index = 0;
      return () => `atom-${index++}`;
    })());

    expect(result.operations).toHaveLength(3);
    expect(result.rejectedCount).toBe(2);
    expect(result.operations[0]).toMatchObject({
      atom: { expiresAt: NOW + 72 * 60 * 60 * 1_000 },
    });
  });

  it("anchors open loops only to an assistant question", () => {
    const result = parseAndValidateSocialExtraction(JSON.stringify({
      operations: [{
        operation: "add",
        type: "open_loop",
        content: "用户还没有继续这个话题",
        evidenceTurnId: "user-2",
        evidenceQuote: "周末有空",
      }],
    }), input());

    expect(result.operations).toEqual([]);
    expect(result.rejectedCount).toBe(1);
  });

  it("requires a future expiry for short-term atoms", () => {
    const result = parseAndValidateSocialExtraction(JSON.stringify({
      operations: [{
        operation: "add",
        type: "short_term",
        content: "用户今天状态不错",
        evidenceTurnId: "user-2",
        evidenceQuote: "周末有空",
      }],
    }), input());

    expect(result.operations).toEqual([]);
    expect(result.rejectedCount).toBe(1);
  });

  it("drops malformed or ambiguous model output instead of guessing or repairing", () => {
    expect(parseAndValidateSocialExtraction("not json", input())).toEqual({
      operations: [],
      rejectedCount: 1,
    });
    expect(parseAndValidateSocialExtraction([
      '{"operations":[]}',
      '{"operations":[{"operation":"resolve"}]}',
    ].join("\n"), input())).toEqual({
      operations: [],
      rejectedCount: 2,
    });
  });
});
