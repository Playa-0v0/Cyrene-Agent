import { describe, expect, it } from "vitest";
import { ContextRefRegistry } from "./context-ref-registry";

const payload = { provider: "netease", trackId: "255667" };

describe("ContextRefRegistry", () => {
  it("resolves a Runtime-issued opaque ref only in its conversation", () => {
    const refs = new ContextRefRegistry({ now: () => 100 });
    const ref = refs.issue({
      conversationId: "c1",
      domain: "music",
      kind: "candidate",
      expiresAt: 200,
      value: payload,
    });

    expect(ref).toMatch(/^ctx_/);
    expect(ref).not.toContain("255667");
    expect(refs.resolve(ref, "c1")).toEqual(payload);
    expect(() => refs.resolve(ref, "c2")).toThrow(/conversation/i);
  });

  it("rejects expired and invented refs", () => {
    let now = 100;
    const refs = new ContextRefRegistry({ now: () => now });
    const ref = refs.issue({
      conversationId: "c1",
      domain: "music",
      kind: "candidate",
      expiresAt: 110,
      value: payload,
    });

    now = 111;
    expect(() => refs.resolve(ref, "c1")).toThrow("E_CONTEXT_REF_EXPIRED");
    expect(() => refs.resolve("ctx_invented", "c1")).toThrow("E_CONTEXT_REF_NOT_FOUND");
  });

  it("caps references per conversation without evicting another conversation", () => {
    let sequence = 0;
    const refs = new ContextRefRegistry({
      now: () => 100,
      maxRefsPerConversation: 2,
      createId: () => `ctx_${++sequence}`,
    });
    const other = refs.issue({ conversationId: "c2", domain: "music", kind: "candidate", expiresAt: 200, value: "other" });
    const first = refs.issue({ conversationId: "c1", domain: "music", kind: "candidate", expiresAt: 200, value: "first" });
    refs.issue({ conversationId: "c1", domain: "music", kind: "candidate", expiresAt: 200, value: "second" });
    refs.issue({ conversationId: "c1", domain: "music", kind: "candidate", expiresAt: 200, value: "third" });

    expect(() => refs.resolve(first, "c1")).toThrow("E_CONTEXT_REF_NOT_FOUND");
    expect(refs.resolve(other, "c2")).toBe("other");
  });

  it("clears one conversation or the whole registry", () => {
    const refs = new ContextRefRegistry({ now: () => 100 });
    const c1 = refs.issue({ conversationId: "c1", domain: "music", kind: "candidate", expiresAt: 200, value: 1 });
    const c2 = refs.issue({ conversationId: "c2", domain: "music", kind: "candidate", expiresAt: 200, value: 2 });

    refs.clear("c1");
    expect(() => refs.resolve(c1, "c1")).toThrow("E_CONTEXT_REF_NOT_FOUND");
    expect(refs.resolve(c2, "c2")).toBe(2);
    refs.clear();
    expect(() => refs.resolve(c2, "c2")).toThrow("E_CONTEXT_REF_NOT_FOUND");
  });

  it("resolves with matching expectedKind", () => {
    const refs = new ContextRefRegistry({ now: () => 100 });
    const ref = refs.issue({ conversationId: "c1", domain: "music", kind: "candidate", expiresAt: 200, value: payload });

    expect(refs.resolve(ref, "c1", "candidate")).toEqual(payload);
  });

  it("rejects mismatched expectedKind", () => {
    const refs = new ContextRefRegistry({ now: () => 100 });
    const candidateRef = refs.issue({ conversationId: "c1", domain: "music", kind: "candidate", expiresAt: 200, value: payload });
    const setRef = refs.issue({ conversationId: "c1", domain: "music", kind: "selection_set", expiresAt: 200, value: { setId: "s1" } });

    // candidate ref 不能用 selection_set 的 kind 去 resolve
    expect(() => refs.resolve(candidateRef, "c1", "selection_set")).toThrow("E_CONTEXT_REF_KIND_MISMATCH");
    // selection_set ref 不能用 candidate 的 kind 去 resolve
    expect(() => refs.resolve(setRef, "c1", "candidate")).toThrow("E_CONTEXT_REF_KIND_MISMATCH");
    // 不传 expectedKind 时两种都能 resolve
    expect(refs.resolve(candidateRef, "c1")).toEqual(payload);
    expect(refs.resolve(setRef, "c1")).toEqual({ setId: "s1" });
  });
});
