import { describe, expect, it, vi } from "vitest";
import { CitaService } from "./cita-service";
import { ContextStore } from "./context-store";
import type { ModelVisibleContext, TurnUnderstanding } from "./contracts";
import type { CitaSemanticEngine } from "./semantic-engine";

const candidateContext: ModelVisibleContext = {
  contextRef: "ctx_music_first",
  conversationId: "c1",
  domain: "music",
  kind: "candidate",
  label: "胆小鬼",
  attributes: { artists: ["梁咏琪"], source: ["daily_recommendation"] },
  position: 1,
  presented: true,
  lifecycle: "active",
  expiresAt: 9_000,
  source: "tool_result",
};

function cognition(input: {
  query: string;
  rewriteStatus: TurnUnderstanding["rewriteStatus"];
  contextualizedQuery?: string;
  withRef?: boolean;
}): TurnUnderstanding {
  return {
    resolvedReferences: input.withRef ? [{
      surface: input.query,
      targetRef: candidateContext.contextRef,
      relation: "focused",
    }] : [],
    focusedEntityRefs: input.withRef ? [candidateContext.contextRef] : [],
    contextualizedQuery: input.contextualizedQuery ?? input.query,
    rewriteStatus: input.rewriteStatus,
  };
}

const cases = [
  {
    name: "self-contained query remains unchanged",
    query: "今天上海天气怎么样？",
    result: cognition({ query: "今天上海天气怎么样？", rewriteStatus: "unchanged" }),
  },
  {
    name: "ordinal selection uses existing ref",
    query: "第一首吧",
    result: cognition({
      query: "第一首吧",
      rewriteStatus: "rewritten",
      contextualizedQuery: "用户选择当前日推候选中的第一首《胆小鬼》。",
      withRef: true,
    }),
  },
  {
    name: "ambiguous reference stays ambiguous",
    query: "就那个吧",
    result: cognition({ query: "就那个吧", rewriteStatus: "insufficient_context" }),
  },
  {
    name: "comment does not become playback",
    query: "第四首名字挺怪",
    result: cognition({ query: "第四首名字挺怪", rewriteStatus: "unchanged" }),
  },
  {
    name: "correction returns to prior topic",
    query: "不是左转灯，是之前日推那个",
    result: cognition({
      query: "不是左转灯，是之前日推那个",
      rewriteStatus: "rewritten",
      contextualizedQuery: "用户纠正目标为此前日推中的《胆小鬼》。",
      withRef: true,
    }),
  },
] as const;

describe("CITA advisory acceptance", () => {
  it.each(cases)("$name", async ({ query, result }) => {
    const store = new ContextStore({ now: () => 1_000 });
    store.append({
      type: "context_upserted", eventId: "event-1", conversationId: "c1",
      occurredAt: 1_000, source: "test", context: candidateContext,
    });
    const engine: CitaSemanticEngine = { understandTurn: vi.fn(async () => result) };
    const service = new CitaService({
      store,
      engine,
      getSettings: () => ({ enabled: true, semanticEngine: "remote" }),
      now: () => 1_000,
    });

    const prepared = await service.prepareTurn({
      conversationId: "c1", turnId: "turn-1", originalQuery: query, recentDialogue: [],
    });

    expect(prepared.contextPackage?.originalQuery).toBe(query);
    expect(prepared.contextPackage?.rewriteStatus).toBe(result.rewriteStatus);
    expect(prepared.contextBlock).toContain("[CITA_CONTEXT]");
    expect(prepared.contextBlock).not.toMatch(/\bmusic_play_track\b|\brequiredTool|\bexecute\b|netease-cloud-music|"trackId"|"setId"|"provider"|\b255667\b|正在播放/);
  });

  it("makes zero semantic calls and injects no marker when disabled", async () => {
    const understandTurn = vi.fn();
    const service = new CitaService({
      store: new ContextStore(),
      engine: { understandTurn },
      getSettings: () => ({ enabled: false, semanticEngine: "remote" }),
    });

    const prepared = await service.prepareTurn({
      conversationId: "c1", turnId: "turn-1", originalQuery: "第一首吧", recentDialogue: [],
    });

    expect(understandTurn).not.toHaveBeenCalled();
    expect(prepared.contextBlock).toBe("");
  });

  it("preserves the original query when semantic understanding is unavailable", async () => {
    const service = new CitaService({
      store: new ContextStore(),
      engine: { understandTurn: vi.fn(async () => { throw new Error("invalid schema"); }) },
      getSettings: () => ({ enabled: true, semanticEngine: "remote" }),
    });

    const prepared = await service.prepareTurn({
      conversationId: "c1", turnId: "turn-1", originalQuery: "就那个吧", recentDialogue: [],
    });

    expect(prepared.contextPackage).toMatchObject({
      originalQuery: "就那个吧",
      contextualizedQuery: "就那个吧",
      semanticStatus: "unavailable",
    });
  });
});
