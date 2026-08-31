import { describe, expect, it, vi } from "vitest";
import { buildMusicTools } from "./music-tools";

const ENC = "4C777A98B81DF0CC069B59F63F3882B1";
const ENC2 = "A".repeat(32);

function serviceDouble() {
  return {
    getDailyRecommendations: vi.fn(),
    getLatestSelectionSet: vi.fn(),
    searchTracks: vi.fn(),
    playTrackFromUi: vi.fn(),
    playPlaylist: vi.fn(),
    getMyPlaylists: vi.fn(),
    getPlaylistDetail: vi.fn(),
    createPlaylist: vi.fn(),
    addToPlaylist: vi.fn(),
    removeFromPlaylist: vi.fn(),
    toggleFavorite: vi.fn(),
    getMySubscriptions: vi.fn(),
    getCachedTracks: vi.fn(),
    removeCachedTrack: vi.fn(),
    getPlaybackState: vi.fn(),
    playbackStop: vi.fn(),
  };
}

function track(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ENC,
    encryptedId: ENC,
    originalId: 3339230677,
    name: "晴天",
    artists: ["周杰伦"],
    album: "叶惠美",
    durationMs: 268000,
    coverUrl: "http://p1.music.126.net/cover.jpg",
    ...overrides,
  };
}

function selectionSet(overrides: Record<string, unknown> = {}) {
  return {
    setId: "daily-raw-id",
    provider: "netease-openapi",
    source: "daily_recommendation",
    createdAt: 900,
    expiresAt: 9_000,
    conversationId: "c1",
    tracks: [track()],
    ...overrides,
  };
}

describe("music Agent tools (M4 — CITA removed)", () => {
  it("declares 15 tools with stable capabilities (music_present_tracks deleted)", () => {
    const tools = buildMusicTools(serviceDouble() as never);
    expect(tools).toHaveLength(15);
    const capabilities = Object.fromEntries(tools.map((t) => [t.id, t.capability]));
    expect(capabilities).toMatchObject({
      music_get_daily_recommendations: "music.daily_recommendations",
      music_search: "music.search",
      music_play_track: "music.play_track",
      music_play_playlist: "music.play_playlist",
      music_get_playback_status: "music.playback_status",
      music_stop_playback: "music.stop_playback",
      music_my_playlists: "music.my_playlists",
      music_playlist_detail: "music.playlist_detail",
      music_create_playlist: "music.create_playlist",
      music_add_to_playlist: "music.add_to_playlist",
      music_toggle_favorite: "music.toggle_favorite",
      music_remove_from_playlist: "music.remove_from_playlist",
      music_my_subscriptions: "music.my_subscriptions",
      music_get_cached_tracks: "music.cached_tracks",
      music_remove_cached_track: "music.remove_cached_track",
    });
    // music_present_tracks is deleted
    expect(tools.find((t) => t.id === "music_present_tracks")).toBeUndefined();
    // 全部工具对 work + learn 模式开放；chat 模式系统级不暴露任何工具
    for (const t of tools) {
      expect(t.modes).toEqual(["work", "learn"]);
    }
  });

  it("music_get_daily_recommendations returns tracks with encryptedId", async () => {
    const service = serviceDouble();
    const set = selectionSet();
    service.getDailyRecommendations.mockResolvedValue(set);
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_get_daily_recommendations")!;

    const output = JSON.parse(await tool.execute({}, { userQuery: "今日推荐", conversationId: "c1", runId: "r1" }));

    expect(output.kind).toBe("recommendations");
    expect(output.tracks[0].encryptedId).toBe(ENC);
    expect(output.tracks[0].originalId).toBe(3339230677);
    expect(output.tracks[0].name).toBe("晴天");
    expect(output.card).toBeUndefined();
  });

  it("music_get_daily_recommendations reuses cached daily set", async () => {
    const service = serviceDouble();
    const set = selectionSet();
    service.getLatestSelectionSet.mockReturnValue(set);
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_get_daily_recommendations")!;

    await tool.execute({}, { userQuery: "今日推荐", conversationId: "c1" });

    expect(service.getDailyRecommendations).not.toHaveBeenCalled();
  });

  it("music_search returns tracks with encryptedId", async () => {
    const service = serviceDouble();
    const set = selectionSet({ source: "search", query: "晴天" });
    service.searchTracks.mockResolvedValue(set);
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_search")!;

    const output = JSON.parse(await tool.execute(
      { keyword: "晴天" },
      { userQuery: "搜索晴天", conversationId: "c1", runId: "r1" },
    ));

    expect(output.kind).toBe("search");
    expect(output.tracks[0].encryptedId).toBe(ENC);
    expect(service.searchTracks).toHaveBeenCalledWith("晴天", "c1", undefined);
    expect(output.card).toBeUndefined();
  });

  it("music_search no longer requires purpose param", async () => {
    const service = serviceDouble();
    const set = selectionSet({ source: "search" });
    service.searchTracks.mockResolvedValue(set);
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_search")!;

    expect(tool.inputSchema.required).toEqual(["keyword"]);
    expect(tool.inputSchema.properties).not.toHaveProperty("purpose");

    await tool.execute({ keyword: "晴天" }, { userQuery: "搜索晴天", conversationId: "c1" });
    expect(service.searchTracks).toHaveBeenCalled();
  });

  it("music_play_track accepts encryptedId and dispatches", async () => {
    const service = serviceDouble();
    service.playTrackFromUi.mockResolvedValue({ state: "dispatched", resourceType: "song", resourceId: ENC });
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_play_track")!;

    const output = JSON.parse(await tool.execute({ encryptedId: ENC }));

    expect(tool.inputSchema.required).toEqual(["encryptedId"]);
    expect(tool.controlledInput).toEqual({ encryptedId: "tool_result" });
    expect(service.playTrackFromUi).toHaveBeenCalledWith(ENC);
    expect(output.dispatch.state).toBe("dispatched");
  });

  it("music_play_track rejects invalid encryptedId (not 32-hex)", async () => {
    const service = serviceDouble();
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_play_track")!;

    await expect(tool.execute({ encryptedId: "short" })).rejects.toThrow("E_INVALID_ENCRYPTED_ID");
    await expect(tool.execute({ encryptedId: "X".repeat(32) })).rejects.toThrow("E_INVALID_ENCRYPTED_ID");
    expect(service.playTrackFromUi).not.toHaveBeenCalled();
  });

  it("music_play_track accepts lowercase hex", async () => {
    const service = serviceDouble();
    service.playTrackFromUi.mockResolvedValue({ state: "dispatched", resourceType: "song", resourceId: ENC });
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_play_track")!;

    await tool.execute({ encryptedId: ENC.toLowerCase() });
    expect(service.playTrackFromUi).toHaveBeenCalledWith(ENC.toLowerCase());
  });

  it("music_play_track does not require needsContext (no CITA)", async () => {
    const tool = buildMusicTools(serviceDouble() as never)
      .find((t) => t.id === "music_play_track")!;
    expect(tool.needsContext).toBe(false);
  });

  it("music_play_playlist dispatches via service", async () => {
    const service = serviceDouble();
    service.playPlaylist.mockResolvedValue({ state: "dispatched", resourceType: "playlist", resourceId: "P".repeat(32) });
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_play_playlist")!;

    const output = JSON.parse(await tool.execute({ playlistId: "P".repeat(32) }));

    expect(service.playPlaylist).toHaveBeenCalledWith("P".repeat(32));
    expect(output.dispatch.state).toBe("dispatched");
  });

  it("music_get_playback_status reports playing track with progress", async () => {
    const service = serviceDouble();
    service.getPlaybackState.mockReturnValue({
      connected: true, loaded: true, paused: false,
      position: 42.5, duration: 268.9, volume: 70,
      track: { encryptedId: ENC, name: "晴天", artists: ["周杰伦"], coverUrl: "http://x/cover.jpg" },
    });
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_get_playback_status")!;

    const output = JSON.parse(await tool.execute({}));

    expect(output).toMatchObject({
      kind: "playback_status",
      connected: true,
      isPlaying: true,
      paused: false,
      track: { encryptedId: ENC, name: "晴天", artists: ["周杰伦"] },
      positionMs: 42500,
      durationMs: 268900,
      volume: 70,
    });
  });

  it("music_get_playback_status reports paused and idle states", async () => {
    const service = serviceDouble();
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_get_playback_status")!;

    service.getPlaybackState.mockReturnValue({
      connected: true, loaded: true, paused: true,
      position: 10, duration: 200, volume: 30,
      track: { encryptedId: ENC, name: "晴天", artists: ["周杰伦"] },
    });
    let output = JSON.parse(await tool.execute({}));
    expect(output.isPlaying).toBe(false);
    expect(output.paused).toBe(true);

    service.getPlaybackState.mockReturnValue({
      connected: true, loaded: false, paused: false,
      position: 0, duration: 0, volume: 70,
    });
    output = JSON.parse(await tool.execute({}));
    expect(output.isPlaying).toBe(false);
    expect(output.paused).toBe(false);
    expect(output.track).toBeNull();
  });

  it("music_stop_playback stops when a track is loaded", async () => {
    const service = serviceDouble();
    service.getPlaybackState.mockReturnValue({
      connected: true, loaded: true, paused: false,
      position: 10, duration: 200, volume: 70,
      track: { encryptedId: ENC, name: "晴天", artists: ["周杰伦"] },
    });
    service.playbackStop.mockResolvedValue(undefined);
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_stop_playback")!;

    const output = JSON.parse(await tool.execute({}));

    expect(service.playbackStop).toHaveBeenCalledTimes(1);
    expect(output).toEqual({ kind: "stop_playback", stopped: true });
  });

  it("music_stop_playback is a no-op when nothing is playing", async () => {
    const service = serviceDouble();
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_stop_playback")!;

    // mpv 未启动
    service.getPlaybackState.mockReturnValue({
      connected: false, loaded: false, paused: false,
      position: 0, duration: 0, volume: 70,
    });
    let output = JSON.parse(await tool.execute({}));
    expect(output).toEqual({ kind: "stop_playback", stopped: false, nothingPlaying: true });

    // mpv 在跑但没有已加载曲目
    service.getPlaybackState.mockReturnValue({
      connected: true, loaded: false, paused: false,
      position: 0, duration: 0, volume: 70,
    });
    output = JSON.parse(await tool.execute({}));
    expect(output.stopped).toBe(false);
    expect(service.playbackStop).not.toHaveBeenCalled();
  });

  it("music_my_playlists returns playlists", async () => {
    const service = serviceDouble();
    service.getMyPlaylists.mockResolvedValue([
      { id: "123", name: "我的歌单", trackCount: 10, creator: "user" },
    ]);
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_my_playlists")!;

    const output = JSON.parse(await tool.execute({}, { userQuery: "我的歌单", conversationId: "c1" }));

    expect(service.getMyPlaylists).toHaveBeenCalled();
    expect(output).toEqual({
      kind: "my_playlists",
      playlists: [{ id: "123", name: "我的歌单", trackCount: 10, creator: "user" }],
    });
  });

  it("music_playlist_detail returns detail", async () => {
    const service = serviceDouble();
    service.getPlaylistDetail.mockResolvedValue({
      id: "123", name: "我的歌单", trackCount: 2,
      tracks: [track()],
    });
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_playlist_detail")!;

    const output = JSON.parse(await tool.execute({ playlistId: "123" }));

    expect(service.getPlaylistDetail).toHaveBeenCalledWith("123");
    expect(output.detail.name).toBe("我的歌单");
  });

  it("music_create_playlist creates with name and privacy", async () => {
    const service = serviceDouble();
    service.createPlaylist.mockResolvedValue({ id: "789", name: "新歌单", trackCount: 0 });
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_create_playlist")!;

    const output = JSON.parse(await tool.execute({ name: "新歌单", privacy: true }));

    expect(service.createPlaylist).toHaveBeenCalledWith("新歌单", { privacy: true });
    expect(output.playlist.id).toBe("789");
  });

  it("music_add_to_playlist adds encryptedIds", async () => {
    const service = serviceDouble();
    service.addToPlaylist.mockResolvedValue({ added: 2, playlistId: "P".repeat(32) });
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_add_to_playlist")!;

    const output = JSON.parse(await tool.execute({ playlistId: "P".repeat(32), trackIds: [ENC, ENC2] }));

    expect(service.addToPlaylist).toHaveBeenCalledWith("P".repeat(32), [ENC, ENC2]);
    expect(output.added).toBe(2);
  });

  it("music_my_subscriptions returns subscriptions", async () => {
    const service = serviceDouble();
    service.getMySubscriptions.mockResolvedValue([{ id: "1", name: "周杰伦" }]);
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_my_subscriptions")!;

    const output = JSON.parse(await tool.execute({ category: "artists" }));

    expect(service.getMySubscriptions).toHaveBeenCalledWith("artists");
    expect(output.subscriptions[0].name).toBe("周杰伦");
  });

  it("music_my_subscriptions rejects invalid category", async () => {
    const service = serviceDouble();
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_my_subscriptions")!;

    await expect(tool.execute({ category: "songs" })).rejects.toThrow("E_INVALID_SUBSCRIPTION_CATEGORY");
    expect(service.getMySubscriptions).not.toHaveBeenCalled();
  });

  it("music_play_track accepts local- cache ids (imported files)", async () => {
    const service = serviceDouble();
    const localId = "local-abc123def456";
    service.playTrackFromUi.mockResolvedValue({ state: "dispatched", resourceType: "song", resourceId: localId });
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_play_track")!;

    const output = JSON.parse(await tool.execute({ encryptedId: localId }));

    expect(service.playTrackFromUi).toHaveBeenCalledWith(localId);
    expect(output.dispatch.state).toBe("dispatched");
  });

  it("music_toggle_favorite calls service with favorite flag", async () => {
    const service = serviceDouble();
    service.toggleFavorite.mockResolvedValue(true);
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_toggle_favorite")!;

    const output = JSON.parse(await tool.execute({ encryptedId: ENC, favorite: true }));

    expect(service.toggleFavorite).toHaveBeenCalledWith(ENC, true);
    expect(output).toEqual({ kind: "toggle_favorite", encryptedId: ENC, favorite: true });
  });

  it("music_toggle_favorite rejects invalid and local- ids", async () => {
    const service = serviceDouble();
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_toggle_favorite")!;

    await expect(tool.execute({ encryptedId: "local-abc123def456", favorite: true }))
      .rejects.toThrow("E_INVALID_ENCRYPTED_ID");
    await expect(tool.execute({ encryptedId: "short", favorite: true }))
      .rejects.toThrow("E_INVALID_ENCRYPTED_ID");
    expect(service.toggleFavorite).not.toHaveBeenCalled();
  });

  it("music_remove_from_playlist removes trackIds", async () => {
    const service = serviceDouble();
    service.removeFromPlaylist.mockResolvedValue({ removed: 2, playlistId: "P".repeat(32) });
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_remove_from_playlist")!;

    const output = JSON.parse(await tool.execute({ playlistId: "P".repeat(32), trackIds: [ENC, ENC2] }));

    expect(service.removeFromPlaylist).toHaveBeenCalledWith("P".repeat(32), [ENC, ENC2]);
    expect(output.kind).toBe("remove_from_playlist");
    expect(output.removed).toBe(2);
  });

  it("music_get_cached_tracks returns tracks with source", async () => {
    const service = serviceDouble();
    service.getCachedTracks.mockResolvedValue([
      track({ source: "netease" }),
      track({ id: "local-abc123def456", encryptedId: "local-abc123def456", name: "本地歌", source: "imported" }),
    ]);
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_get_cached_tracks")!;

    const output = JSON.parse(await tool.execute({}));

    expect(output.kind).toBe("cached_tracks");
    expect(output.tracks[0].source).toBe("netease");
    expect(output.tracks[1].encryptedId).toBe("local-abc123def456");
    expect(output.tracks[1].source).toBe("imported");
  });

  it("music_remove_cached_track removes by hex or local- id", async () => {
    const service = serviceDouble();
    service.removeCachedTrack.mockResolvedValue(true);
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_remove_cached_track")!;

    const output = JSON.parse(await tool.execute({ trackId: "local-abc123def456" }));
    expect(service.removeCachedTrack).toHaveBeenCalledWith("local-abc123def456");
    expect(output).toEqual({ kind: "remove_cached_track", trackId: "local-abc123def456", removed: true });

    await tool.execute({ trackId: ENC });
    expect(service.removeCachedTrack).toHaveBeenCalledWith(ENC);
  });

  it("music_remove_cached_track rejects invalid id", async () => {
    const service = serviceDouble();
    const tool = buildMusicTools(service as never)
      .find((t) => t.id === "music_remove_cached_track")!;

    await expect(tool.execute({ trackId: "junk" })).rejects.toThrow("E_INVALID_ENCRYPTED_ID");
    expect(service.removeCachedTrack).not.toHaveBeenCalled();
  });

  it("no CITA imports remain (no ContextRefRegistry, no contextRefRegistry)", () => {
    // This test documents the CITA removal. If someone re-introduces CITA
    // imports, this will fail at compile time.
    const tool = buildMusicTools(serviceDouble() as never);
    expect(tool.length).toBe(15);
    // No tool has controlledInput with context_ref type
    for (const t of tool) {
      if (t.controlledInput) {
        const vals = Object.values(t.controlledInput);
        for (const v of vals) {
          if (typeof v === "object" && v !== null && "type" in v) {
            expect((v as { type: string }).type).not.toBe("context_ref");
            expect((v as { type: string }).type).not.toBe("context_ref_array");
          }
        }
      }
    }
  });
});
