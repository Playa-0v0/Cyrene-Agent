import { describe, expect, it, vi } from "vitest";
import { ContextRefRegistry } from "../context-ref-registry";
import { buildMusicTools } from "./music-tools";

function serviceDouble() {
  return {
    getDailyRecommendations: vi.fn(),
    getLatestSelectionSet: vi.fn(),
    searchTracks: vi.fn(),
    presentTracks: vi.fn(),
    markTracksPresented: vi.fn(),
    getSelectionSet: vi.fn(),
    playTrack: vi.fn(),
    playPlaylist: vi.fn(),
  };
}

function registry(now = () => 1_000) {
  let sequence = 0;
  return new ContextRefRegistry({ now, createId: () => `ctx_${++sequence}` });
}

function selectionSet(overrides: Record<string, unknown> = {}) {
  return {
    setId: "daily-raw-id",
    provider: "netease-cloud-music",
    source: "daily_recommendation",
    createdAt: 900,
    expiresAt: 9_000,
    conversationId: "c1",
    tracks: [{ id: "255667", name: "胆小鬼", artists: ["梁咏琪"], album: "最爱梁咏琪" }],
    ...overrides,
  };
}

describe("music Agent tools", () => {
  it("declares stable capabilities for Action Gate routing", () => {
    const capabilities = Object.fromEntries(
      buildMusicTools(serviceDouble() as never).map((tool) => [tool.id, tool.capability]),
    );

    expect(capabilities).toMatchObject({
      music_get_daily_recommendations: "music.daily_recommendations",
      music_search: "music.search",
      music_present_tracks: "music.present_tracks",
      music_play_track: "music.play_track",
      music_play_playlist: "music.play_playlist",
    });
  });

  it("returns opaque daily candidates and publishes only safe CITA projections", async () => {
    const service = serviceDouble();
    const set = selectionSet();
    service.getDailyRecommendations.mockResolvedValue(set);
    service.presentTracks.mockResolvedValue({ cardRef: "internal-card" });
    service.getSelectionSet.mockReturnValue(set);
    const contextRefs = registry();
    const ingestContextEvent = vi.fn();
    const sendCard = vi.fn(() => true);
    const tool = buildMusicTools(service as never, { contextRefs, ingestContextEvent, sendCard })
      .find((candidate) => candidate.id === "music_get_daily_recommendations")!;

    const outputText = await tool.execute({}, {
      userQuery: "今日推荐",
      conversationId: "c1",
      runId: "run-1",
      contextRefs,
    });
    const output = JSON.parse(outputText);

    expect(output).toEqual({
      kind: "recommendations",
      context: {
        setRef: "ctx_1",
        source: "daily_recommendation",
        candidates: [{
          candidateRef: "ctx_2",
          position: 1,
          name: "胆小鬼",
          artists: ["梁咏琪"],
          album: "最爱梁咏琪",
        }],
      },
      presentation: { presented: true },
    });
    expect(outputText).not.toContain("255667");
    expect(outputText).not.toContain("daily-raw-id");
    expect(outputText).not.toContain("netease-cloud-music");
    expect(service.markTracksPresented).toHaveBeenCalledWith("daily-raw-id", "c1", ["255667"]);
    expect(sendCard).toHaveBeenCalledWith(expect.objectContaining({ tracks: set.tracks }));
    expect(ingestContextEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "context_presented",
      contextRefs: ["ctx_2"],
    }));
  });

  it("reuses the current daily set and does not render the same card twice", async () => {
    const service = serviceDouble();
    const set = selectionSet({ presentedTrackIds: ["255667"], presentedAt: 950 });
    service.getLatestSelectionSet.mockReturnValue(set);
    service.getSelectionSet.mockReturnValue(set);
    service.presentTracks.mockResolvedValue({ cardRef: "internal-card" });
    const contextRefs = registry();
    const sendCard = vi.fn(() => true);
    const ingestContextEvent = vi.fn();
    const tool = buildMusicTools(service as never, { contextRefs, sendCard, ingestContextEvent })
      .find((candidate) => candidate.id === "music_get_daily_recommendations")!;

    const first = JSON.parse(await tool.execute({}, {
      userQuery: "今日推荐",
      conversationId: "c1",
      runId: "run-1",
      contextRefs,
    }));
    const second = JSON.parse(await tool.execute({}, {
      userQuery: "再试一次",
      conversationId: "c1",
      runId: "run-2",
      contextRefs,
    }));

    expect(service.getDailyRecommendations).not.toHaveBeenCalled();
    expect(first.context).toEqual(second.context);
    expect(first.presentation).toEqual({ presented: true, reused: true });
    expect(second.presentation).toEqual({ presented: true, reused: true });
    expect(sendCard).not.toHaveBeenCalled();
    expect(ingestContextEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "context_presented",
      contextRefs: first.context.candidates.map((candidate: { candidateRef: string }) => candidate.candidateRef),
    }));
  });

  it("does not mark candidates presented when card delivery fails", async () => {
    const service = serviceDouble();
    const set = selectionSet();
    service.getDailyRecommendations.mockResolvedValue(set);
    service.presentTracks.mockResolvedValue({ cardRef: "internal-card" });
    service.getSelectionSet.mockReturnValue(set);
    const contextRefs = registry();
    const tool = buildMusicTools(service as never, {
      contextRefs,
      sendCard: () => { throw new Error("renderer unavailable"); },
    }).find((candidate) => candidate.id === "music_get_daily_recommendations")!;

    await expect(tool.execute({}, { userQuery: "日推", conversationId: "c1", contextRefs }))
      .rejects.toThrow("renderer unavailable");
    expect(service.markTracksPresented).not.toHaveBeenCalled();
  });

  it("does not mark candidates presented when no card recipient exists", async () => {
    const service = serviceDouble();
    const set = selectionSet();
    service.getDailyRecommendations.mockResolvedValue(set);
    service.presentTracks.mockResolvedValue({ cardRef: "internal-card" });
    service.getSelectionSet.mockReturnValue(set);
    const contextRefs = registry();
    const ingestContextEvent = vi.fn();
    const tool = buildMusicTools(service as never, {
      contextRefs,
      ingestContextEvent,
      sendCard: () => false,
    }).find((candidate) => candidate.id === "music_get_daily_recommendations")!;

    const output = JSON.parse(await tool.execute({}, { userQuery: "日推", conversationId: "c1", contextRefs }));

    expect(output.presentation).toEqual({ presented: false });
    expect(service.markTracksPresented).not.toHaveBeenCalled();
    expect(ingestContextEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "context_presented" }));
  });

  it("resolves candidateRef internally before delegating playback", async () => {
    const service = serviceDouble();
    service.playTrack.mockResolvedValue({ state: "dispatched", resourceType: "song", resourceId: "255667" });
    const contextRefs = registry();
    const candidateRef = contextRefs.issue({
      conversationId: "c1",
      domain: "music",
      kind: "candidate",
      expiresAt: 9_000,
      value: {
        provider: "netease-cloud-music",
        setId: "daily-raw-id",
        trackId: "255667",
        conversationId: "c1",
      },
    });
    const tool = buildMusicTools(service as never, { contextRefs })
      .find((candidate) => candidate.id === "music_play_track")!;

    const output = JSON.parse(await tool.execute(
      { candidateRef },
      { userQuery: "播放第一首", conversationId: "c1", runId: "run-1", contextRefs },
    ));

    expect(tool.inputSchema).toEqual(expect.objectContaining({ required: ["candidateRef"] }));
    expect(tool.controlledInput).toEqual({ candidateRef: { type: "context_ref", kind: "candidate" } });
    expect(service.playTrack).toHaveBeenCalledWith({
      provider: "netease-cloud-music",
      setId: "daily-raw-id",
      trackId: "255667",
      conversationId: "c1",
      runId: "run-1",
    });
    expect(output.dispatch.state).toBe("dispatched");
  });

  it.each([
    { name: "cross-conversation", ref: "valid", conversationId: "c2", error: /CONVERSATION/ },
    { name: "invented", ref: "ctx_invented", conversationId: "c1", error: /NOT_FOUND/ },
  ])("rejects $name refs before playback", async ({ ref, conversationId, error }) => {
    const service = serviceDouble();
    const contextRefs = registry();
    const valid = contextRefs.issue({
      conversationId: "c1", domain: "music", kind: "candidate", expiresAt: 9_000,
      value: { provider: "netease-cloud-music", setId: "s1", trackId: "1", conversationId: "c1" },
    });
    const tool = buildMusicTools(service as never, { contextRefs })
      .find((candidate) => candidate.id === "music_play_track")!;

    await expect(tool.execute(
      { candidateRef: ref === "valid" ? valid : ref },
      { userQuery: "播放", conversationId, contextRefs },
    )).rejects.toThrow(error);
    expect(service.playTrack).not.toHaveBeenCalled();
  });

  it("rejects expired refs before playback", async () => {
    let now = 1_000;
    const service = serviceDouble();
    const contextRefs = registry(() => now);
    const candidateRef = contextRefs.issue({
      conversationId: "c1", domain: "music", kind: "candidate", expiresAt: 1_100,
      value: { provider: "netease-cloud-music", setId: "s1", trackId: "1", conversationId: "c1" },
    });
    now = 1_101;
    const tool = buildMusicTools(service as never, { contextRefs })
      .find((candidate) => candidate.id === "music_play_track")!;

    await expect(tool.execute({ candidateRef }, { userQuery: "播放", conversationId: "c1", contextRefs }))
      .rejects.toThrow(/EXPIRED/);
    expect(service.playTrack).not.toHaveBeenCalled();
  });

  it("resolves ordered candidateRefs to one real set for presentation", async () => {
    const service = serviceDouble();
    const set = selectionSet({
      setId: "s1",
      tracks: [
        { id: "101", name: "晴天", artists: ["周杰伦"] },
        { id: "102", name: "夜曲", artists: ["周杰伦"] },
      ],
    });
    service.presentTracks.mockResolvedValue({ cardRef: "internal-card" });
    service.getSelectionSet.mockReturnValue(set);
    const contextRefs = registry();
    const first = contextRefs.issue({ conversationId: "c1", domain: "music", kind: "candidate", expiresAt: 9_000,
      value: { provider: set.provider, setId: "s1", trackId: "101", conversationId: "c1" } });
    const second = contextRefs.issue({ conversationId: "c1", domain: "music", kind: "candidate", expiresAt: 9_000,
      value: { provider: set.provider, setId: "s1", trackId: "102", conversationId: "c1" } });
    const tool = buildMusicTools(service as never, { contextRefs, sendCard: vi.fn(() => true) })
      .find((candidate) => candidate.id === "music_present_tracks")!;

    expect(tool.controlledInput).toEqual({ candidateRefs: { type: "context_ref_array", kind: "candidate" } });

    await tool.execute({ candidateRefs: [second, first] }, { userQuery: "展示", conversationId: "c1", contextRefs });

    expect(service.presentTracks).toHaveBeenCalledWith(expect.objectContaining({ setId: "s1", trackIds: ["102", "101"] }));
    expect(service.markTracksPresented).toHaveBeenCalledWith("s1", "c1", ["102", "101"]);
  });

  it("uses the model-selected search purpose without inferring from user wording", async () => {
    const service = serviceDouble();
    const set = selectionSet({ source: "search", query: "稻香", resolutionPurpose: "play" });
    service.searchTracks.mockResolvedValue(set);
    const contextRefs = registry();
    const tool = buildMusicTools(service as never, { contextRefs })
      .find((candidate) => candidate.id === "music_search")!;

    const output = await tool.execute(
      { keyword: "稻香", purpose: "discover" },
      { userQuery: "播放稻香", conversationId: "c1", runId: "run-1", contextRefs },
    );

    expect(service.searchTracks).toHaveBeenCalledWith("稻香", "c1", undefined, {
      resolutionRunId: "run-1",
      purpose: "discover",
    });
    expect(output).not.toContain("255667");
    expect(output).not.toContain("netease-cloud-music");
  });

  it("rejects a missing search purpose instead of guessing from user wording", async () => {
    const service = serviceDouble();
    const tool = buildMusicTools(service as never)
      .find((candidate) => candidate.id === "music_search")!;

    await expect(tool.execute(
      { keyword: "稻香" },
      { userQuery: "播放稻香", conversationId: "c1", runId: "run-1" },
    )).rejects.toThrow("E_MUSIC_SEARCH_PURPOSE_REQUIRED");
    expect(service.searchTracks).not.toHaveBeenCalled();
  });

  it("music_play_playlist remains a real service call", async () => {
    const service = serviceDouble();
    service.playPlaylist.mockResolvedValue({ state: "dispatched", resourceType: "playlist", resourceId: "456" });
    const tool = buildMusicTools(service as never).find((candidate) => candidate.id === "music_play_playlist")!;
    expect(tool.controlledInput).toEqual({ playlistId: "tool_result" });

    await tool.execute({ playlistId: "456" });

    expect(service.playPlaylist).toHaveBeenCalledWith("456");
  });
});
