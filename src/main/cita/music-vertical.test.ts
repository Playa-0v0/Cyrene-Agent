import { describe, expect, it, vi } from "vitest";
import { ContextRefRegistry } from "../orchestrator/context-ref-registry";
import { buildMusicTools } from "../orchestrator/tools/music-tools";
import { CitaService } from "./cita-service";
import { ContextStore } from "./context-store";
import type { CitaSemanticEngine } from "./semantic-engine";
import type { TurnUnderstanding, TurnUnderstandingInput } from "./contracts";

function serviceDouble() {
  return {
    getDailyRecommendations: vi.fn(),
    getLatestSelectionSet: vi.fn(),
    searchTracks: vi.fn(),
    presentTracks: vi.fn(async () => ({ cardRef: "internal-card" })),
    markTracksPresented: vi.fn(),
    getSelectionSet: vi.fn(),
    playTrack: vi.fn(),
    playPlaylist: vi.fn(),
  };
}

function understanding(input: TurnUnderstandingInput): TurnUnderstanding {
  const candidate = input.availableContexts.find((context) => context.kind === "candidate" && context.position === 1);
  if (input.originalQuery === "第一首吧" && candidate) {
    return {
      resolvedReferences: [{ surface: "第一首", targetRef: candidate.contextRef, relation: "candidate_position" }],
      focusedEntityRefs: [candidate.contextRef],
      contextualizedQuery: `用户选择当前歌曲候选中的第一首《${candidate.label}》。`,
      rewriteStatus: "rewritten",
    };
  }
  if (input.originalQuery === "第四首名字挺怪") {
    return {
      resolvedReferences: [],
      focusedEntityRefs: [],
      contextualizedQuery: input.originalQuery,
      rewriteStatus: "unchanged",
    };
  }
  return {
    resolvedReferences: [],
    focusedEntityRefs: [],
    contextualizedQuery: input.originalQuery,
    rewriteStatus: "unchanged",
  };
}

function setup() {
  let sequence = 0;
  const refs = new ContextRefRegistry({ now: () => 1_000, createId: () => `ctx_${++sequence}` });
  const store = new ContextStore({ now: () => 1_000 });
  const engine: CitaSemanticEngine = { understandTurn: vi.fn(async (input) => understanding(input)) };
  const cita = new CitaService({
    store,
    engine,
    getSettings: () => ({ enabled: true, semanticEngine: "remote" }),
    now: () => 1_000,
  });
  const service = serviceDouble();
  const hooks = {
    contextRefs: refs,
    ingestContextEvent: (event: Parameters<CitaService["ingest"]>[0]) => cita.ingest(event),
    sendCard: vi.fn(() => true),
  };
  return { refs, store, engine, cita, service, hooks };
}

describe("CITA music vertical", () => {
  it("projects the exact displayed order and resolves the first opaque candidate", async () => {
    const env = setup();
    const set = {
      setId: "raw-set", provider: "netease-cloud-music", source: "daily_recommendation",
      createdAt: 900, expiresAt: 9_000, conversationId: "c1",
      tracks: [
        { id: "11", name: "胆小鬼", artists: ["梁咏琪"] },
        { id: "22", name: "Chasing Tonight", artists: ["zoolor"] },
      ],
    };
    env.service.getDailyRecommendations.mockResolvedValue(set);
    env.service.getSelectionSet.mockReturnValue(set);
    const tool = buildMusicTools(env.service as never, env.hooks)
      .find((candidate) => candidate.id === "music_get_daily_recommendations")!;

    await tool.execute({}, { userQuery: "今日推荐", conversationId: "c1", contextRefs: env.refs });
    const candidates = env.store.snapshot("c1").contexts.filter((context) => context.kind === "candidate");
    expect(candidates.map((context) => [context.position, context.label, context.presented])).toEqual([
      [1, "胆小鬼", true],
      [2, "Chasing Tonight", true],
    ]);

    const prepared = await env.cita.prepareTurn({
      conversationId: "c1", turnId: "turn-2", originalQuery: "第一首吧", recentDialogue: [],
    });
    expect(prepared.contextPackage).toMatchObject({
      resolvedReferences: [{ targetRef: candidates[0].contextRef }],
      semanticStatus: "ready",
    });
    expect(prepared.contextBlock).not.toContain("music_play_track");
    expect(prepared.contextBlock).not.toContain("trackId");
  });

  it("keeps comments and affirmations as cognition rather than execution directives", async () => {
    const env = setup();
    const comment = await env.cita.prepareTurn({
      conversationId: "c1", turnId: "turn-comment", originalQuery: "第四首名字挺怪", recentDialogue: [],
    });
    expect(comment.contextBlock).not.toContain("toolName");

    const withoutQuestion = await env.cita.prepareTurn({
      conversationId: "c1", turnId: "turn-no-question", originalQuery: "好啊", recentDialogue: [],
    });

    env.cita.ingest({
      type: "context_upserted", eventId: "awaiting-1", conversationId: "c1", occurredAt: 1_000, source: "test",
      context: {
        contextRef: "ctx_awaiting", conversationId: "c1", domain: "dialogue", kind: "awaiting_question",
        label: "是否播放当前歌曲", lifecycle: "active", source: "runtime_event",
      },
    });
    const withQuestion = await env.cita.prepareTurn({
      conversationId: "c1", turnId: "turn-question", originalQuery: "好啊", recentDialogue: [],
    });
    expect(env.service.playTrack).not.toHaveBeenCalled();
  });

  it("keeps daily and search candidate sources distinguishable", async () => {
    const env = setup();
    const daily = {
      setId: "daily", provider: "netease-cloud-music", source: "daily_recommendation",
      createdAt: 900, expiresAt: 9_000, conversationId: "c1",
      tracks: [{ id: "11", name: "日推歌", artists: ["A"] }],
    };
    const search = {
      ...daily, setId: "search", source: "search", query: "左转灯",
      tracks: [{ id: "22", name: "左转灯", artists: ["派伟俊"] }],
    };
    env.service.getDailyRecommendations.mockResolvedValue(daily);
    env.service.searchTracks.mockResolvedValue(search);
    env.service.getSelectionSet.mockImplementation((setId: string) => setId === "daily" ? daily : search);
    const tools = buildMusicTools(env.service as never, env.hooks);

    await tools.find((tool) => tool.id === "music_get_daily_recommendations")!
      .execute({}, { userQuery: "日推", conversationId: "c1", contextRefs: env.refs });
    await tools.find((tool) => tool.id === "music_search")!
      .execute({ keyword: "左转灯", purpose: "discover" }, { userQuery: "搜左转灯", conversationId: "c1", contextRefs: env.refs });

    const sources = env.store.snapshot("c1").contexts
      .filter((context) => context.kind === "candidate")
      .map((context) => context.attributes?.source?.[0]);
    expect(sources).toEqual(["daily_recommendation", "search"]);
  });
});
