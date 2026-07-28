import { describe, expect, it } from "vitest";
import { compileSocialContextBlock } from "./context";
import { rankSocialAtoms } from "./retrieval";
import { createSocialAtomStore } from "./store";
import type { SocialAtom } from "./types";

function atom(
  id: string,
  content: string,
  overrides: Partial<SocialAtom> = {},
): SocialAtom {
  return {
    id,
    conversationId: "chat-a",
    type: "long_term",
    content,
    evidenceTurnId: `turn-${id}`,
    evidenceQuote: content,
    createdAt: Date.parse("2026-07-20T00:00:00Z"),
    status: "active",
    ...overrides,
  };
}

describe("social atom store", () => {
  it("isolates conversations and filters expired or inactive atoms", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([
      atom("a", "用户喜欢海边"),
      atom("b", "另一个会话", { conversationId: "chat-b" }),
      atom("c", "已经过期", { expiresAt: 10 }),
      atom("d", "已被纠正", { status: "superseded" }),
    ]);

    expect(store.listActive("chat-a", 20).map((item) => item.id)).toEqual(["a"]);
    expect(store.listActive("chat-b", 20).map((item) => item.id)).toEqual(["b"]);
  });

  it("adds a correction atom and marks its target superseded", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([atom("old", "用户住在上海")]);

    store.applyOperations("chat-a", [{
      operation: "supersede",
      atom: atom("new", "用户已经搬到杭州", {
        evidenceTurnId: "user-2",
        evidenceQuote: "我搬到杭州了",
      }),
      targetAtomId: "old",
    }], 100);

    expect(store.getById("old")?.status).toBe("superseded");
    expect(store.getById("old")?.supersededByAtomId).toBe("new");
    expect(store.listActive("chat-a", 100).map((item) => item.id)).toEqual(["new"]);
  });

  it("resolves only an active open loop without creating a new atom", () => {
    const store = createSocialAtomStore();
    store.replaceForTest([
      atom("loop", "用户还没有回答周末是否有空", {
        type: "open_loop",
        evidenceTurnId: "assistant-1",
        evidenceQuote: "你周末有空吗",
        expiresAt: 500,
      }),
    ]);

    store.applyOperations("chat-a", [{
      operation: "resolve",
      targetAtomId: "loop",
      evidenceTurnId: "user-2",
      evidenceQuote: "周末有空",
    }], 100);

    expect(store.getById("loop")?.status).toBe("resolved");
    expect(store.listActive("chat-a", 100)).toEqual([]);
  });

  it("deduplicates retry writes by stable evidence turn and normalized content", () => {
    const store = createSocialAtomStore();
    const first = atom("first", "用户喜欢海边", {
      evidenceTurnId: "user-1",
      evidenceQuote: "我喜欢海边",
    });
    const retry = { ...first, id: "retry" };

    store.applyOperations("chat-a", [{ operation: "add", atom: first }], 100);
    store.applyOperations("chat-a", [{ operation: "add", atom: retry }], 100);

    expect(store.listActive("chat-a", 100).map((item) => item.id)).toEqual(["first"]);
  });
});

describe("social atom retrieval", () => {
  it("uses lexical relevance with recency decay and returns at most five active atoms", () => {
    const now = Date.parse("2026-07-24T00:00:00Z");
    const atoms = [
      atom("old-cat", "用户喜欢猫，也养过一只橘猫", { createdAt: now - 60 * 86_400_000 }),
      atom("new-cat", "用户刚领养了一只布偶猫", { createdAt: now - 86_400_000 }),
      atom("sea", "用户喜欢去海边散步", { createdAt: now - 1_000 }),
      ...Array.from({ length: 6 }, (_, index) => (
        atom(`extra-${index}`, `用户提到猫的事情 ${index}`, { createdAt: now - index * 1_000 })
      )),
    ];

    const ranked = rankSocialAtoms("想聊聊我的猫", atoms, { now, limit: 5 });

    expect(ranked).toHaveLength(5);
    expect(ranked[0].id).not.toBe("old-cat");
    expect(ranked.some((item) => item.id === "sea")).toBe(false);
  });

  it("returns no unrelated facts but can surface a recent open loop", () => {
    const now = 1_000_000;
    const ranked = rankSocialAtoms("晚上好", [
      atom("fact", "用户喜欢潜水", { createdAt: now - 1_000 }),
      atom("loop", "用户还没回答今天有没有吃饭", {
        type: "open_loop",
        createdAt: now - 1_000,
        expiresAt: now + 1_000,
      }),
    ], { now, limit: 5 });

    expect(ranked.map((item) => item.id)).toEqual(["loop"]);
  });
});

describe("social context compiler", () => {
  it("omits an empty block", () => {
    expect(compileSocialContextBlock([])).toBe("");
  });

  it("separates relevant past from open loops and instructs Soul to use it naturally", () => {
    const block = compileSocialContextBlock([
      atom("fact", "用户喜欢海边"),
      atom("loop", "用户还没有回答周末是否有空", { type: "open_loop" }),
    ]);

    expect(block).toContain("相关的过去");
    expect(block).toContain("尚未接上的话题");
    expect(block).toContain("用户喜欢海边");
    expect(block).toContain("不要复述这份背景");
    expect(block).not.toContain("evidenceTurnId");
  });
});
