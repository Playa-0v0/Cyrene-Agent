import { describe, it, expect, beforeEach, vi } from "vitest";

const handlerMap: Record<string, (e: unknown, payload: unknown) => Promise<unknown>> = {};
const removed: string[] = [];
// Collect state-change listeners so tests can trigger them
const stateListeners: Array<(s: unknown) => void> = [];

vi.mock("electron", () => ({
  shell: { openPath: vi.fn().mockResolvedValue("") },
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, payload: unknown) => Promise<unknown> | unknown) => {
      handlerMap[channel] = fn as (e: unknown, payload: unknown) => Promise<unknown>;
    },
    removeHandler: (channel: string) => {
      removed.push(channel);
    },
  },
}));

import { registerMusicIpcHandlers } from "./ipc-handlers";
import { MusicInputError } from "./types";

  function mockService(overrides: Record<string, unknown> = {}): any {
    // Real service methods are async; mirrors must return a Promise so the
    // wrap helper can `.then()` on the result. The default mocks reject with
    // the same MusicInputError codes the real service throws, so input-validation
    // tests can assert the IPC envelope without spinning up a full MusicService.
    function asyncThat(impl?: (...args: any[]) => any): any {
      const fn = vi.fn(async (...args: unknown[]) => {
        if (impl) return impl(...args);
        return undefined;
      });
      return fn;
    }
    function searchImpl(keyword: unknown): unknown {
      const trimmed = (typeof keyword === "string" ? keyword : "").trim();
      if (trimmed.length === 0) throw new MusicInputError("E_INVALID_KEYWORD_EMPTY");
      if (trimmed.length > 100) throw new MusicInputError("E_INVALID_KEYWORD_TOO_LONG");
      return undefined;
    }
    function playTrackImpl(trackId: unknown): unknown {
      if (typeof trackId !== "string" || !/^\d+$/.test(trackId)) throw new MusicInputError("E_INVALID_ID_FORMAT");
      return undefined;
    }
    function onStateChangeImpl(listener: (s: unknown) => void): () => void {
      stateListeners.push(listener);
      return () => {
        const i = stateListeners.indexOf(listener);
        if (i >= 0) stateListeners.splice(i, 1);
      };
    }
    const base: any = {
      getBackendState: vi.fn(() => "ready"),
      getAccountState: vi.fn(() => "signed_in"),
      getPlayerState: vi.fn(() => "available"),
      getLoginFlowState: vi.fn(() => "idle"),
      getRootPid: vi.fn(() => undefined),
      getLyricsCacheDir: vi.fn(() => "/tmp/lyrics-cache"),
      onStateChange: vi.fn(onStateChangeImpl),
      onPlaybackStateChange: vi.fn(() => () => {}),
      onPlaybackSessionChange: vi.fn(() => () => {}),
      onCacheUpdated: vi.fn(() => () => {}),
      pollOnce: asyncThat(),
      beginLogin: asyncThat(),
      cancelLogin: asyncThat(),
      logout: asyncThat(),
      getDailyRecommendations: asyncThat(),
      searchTracks: asyncThat(searchImpl),
      playTrackFromUi: asyncThat(playTrackImpl),
      playPlaylist: asyncThat(playTrackImpl),
      getPlaybackSession: vi.fn(() => null),
      playSessionTrack: asyncThat(),
      syncPlaybackSession: asyncThat(),
      getOpenapiConfig: asyncThat(async () => null),
      applyOpenapiConfig: asyncThat(async () => undefined),
    };
    for (const [k, v] of Object.entries(overrides)) base[k] = v;
    return base;
  }

  beforeEach(() => {
    for (const k of Object.keys(handlerMap)) delete handlerMap[k];
    removed.length = 0;
    stateListeners.length = 0;
  });

describe("registerMusicIpcHandlers", () => {
  it("registers all music invoke channels", () => {
    registerMusicIpcHandlers(mockService());
    const expected = [
      "music:get-status",
      "music:begin-login",
      "music:cancel-login",
      "music:logout",
      "music:get-daily",
      "music:search",
      "music:play-track",
      "music:play-playlist",
      "music:get-my-playlists",
      "music:get-playlist-detail",
      "music:detect-player",
      "music:get-openapi-config",
      "music:save-openapi-config",
      "music:playback:play",
      "music:playback:pause",
      "music:playback:toggle",
      "music:playback:seek",
      "music:playback:volume",
      "music:playback:stop",
      "music:playback:next",
      "music:playback:prev",
      "music:playback-session:get",
      "music:playback-session:play",
      "music:playback-session:sync",
      "music:get-lyrics",
      "music:toggle-favorite",
      "music:get-cached-tracks",
      "music:remove-cached-track",
      "music:import-local-tracks",
    ];
    for (const ch of expected) {
      expect(handlerMap[ch]).toBeDefined();
    }
  });

  it("returns a disposer that removes all handlers", () => {
    const disposer = registerMusicIpcHandlers(mockService());
    disposer();
    expect(removed).toContain("music:get-status");
    expect(removed).toContain("music:play-track");
    // 本地音乐的文件夹导入入口
    expect(removed).toContain("music:import-local-folder");
    expect(removed.length).toBe(30);
  });

  it("returns the background playback session for a newly opened player window", async () => {
    const snapshot = { queue: [], queueIndex: -1, playbackMode: "off", playlistId: "" };
    registerMusicIpcHandlers(mockService({ getPlaybackSession: vi.fn(() => snapshot) }));

    await expect(handlerMap["music:playback-session:get"](null, null)).resolves.toEqual({ ok: true, data: snapshot });
  });

  it("MUSIC_SEARCH: keyword too long returns ok:false errorCode", async () => {
    registerMusicIpcHandlers(mockService());
    const r = await handlerMap["music:search"](null, { keyword: "x".repeat(101) });
    expect(r).toEqual({
      ok: false,
      errorCode: "E_INVALID_KEYWORD_TOO_LONG",
      backendState: "ready",
      accountState: "signed_in",
      playerState: "available",
    });
  });

  it("MUSIC_SEARCH: empty keyword returns ok:false errorCode", async () => {
    registerMusicIpcHandlers(mockService());
    const r = await handlerMap["music:search"](null, { keyword: "   " });
    expect(r).toEqual({
      ok: false,
      errorCode: "E_INVALID_KEYWORD_EMPTY",
      backendState: "ready",
      accountState: "signed_in",
      playerState: "available",
    });
  });

  it("MUSIC_PLAY_TRACK: non-numeric id returns ok:false", async () => {
    registerMusicIpcHandlers(mockService());
    const r = await handlerMap["music:play-track"](null, "abc");
    expect(r).toEqual({
      ok: false,
      errorCode: "E_INVALID_ID_FORMAT",
      backendState: "ready",
      accountState: "signed_in",
      playerState: "available",
    });
  });

  it("successful path returns ok:true with data", async () => {
    const svc = mockService();
    svc.searchTracks.mockResolvedValue({
      setId: "s1", source: "search", query: "q",
      createdAt: 0, expiresAt: 0, conversationId: "c1", tracks: [],
    });
    registerMusicIpcHandlers(svc);
    const r = (await handlerMap["music:search"](null, { keyword: "q" })) as any;
    expect(r.ok).toBe(true);
    expect(r.data.setId).toBe("s1");
  });

  it("MUSIC_GET_STATUS: response includes login flow state", async () => {
    const svc = mockService();
    svc.getBackendState.mockReturnValue("ready");
    svc.getAccountState.mockReturnValue("signed_in");
    svc.getPlayerState.mockReturnValue("available");
    svc.getLoginFlowState.mockReturnValue("waiting_scan");
    registerMusicIpcHandlers(svc);
    const r = (await handlerMap["music:get-status"](null, undefined)) as any;
    expect(r.ok).toBe(true);
    expect(r.data).toHaveProperty("flow");
    expect(r.data.flow).toBe("waiting_scan");
    expect(r.data.backend).toBe("ready");
    expect(r.data.account).toBe("signed_in");
    expect(r.data.player).toBe("available");
  });

  it("MUSIC_GET_STATUS: advances an active login before returning the snapshot", async () => {
    const svc = mockService();
    svc.getAccountState.mockReturnValue("signed_out");
    svc.getLoginFlowState.mockReturnValue("creating_qr");
    svc.pollOnce.mockImplementation(async () => {
      svc.getLoginFlowState.mockReturnValue("waiting_confirm");
    });
    registerMusicIpcHandlers(svc);

    const r = (await handlerMap["music:get-status"](null, undefined)) as any;

    expect(svc.pollOnce).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.data.flow).toBe("waiting_confirm");
  });

  it("MUSIC_GET_STATUS: does not poll an idle or terminal login", async () => {
    const svc = mockService();
    svc.getLoginFlowState.mockReturnValue("idle");
    registerMusicIpcHandlers(svc);

    await handlerMap["music:get-status"](null, undefined);

    expect(svc.pollOnce).not.toHaveBeenCalled();
  });

  it("non-MusicInputError exception is converted to E_INTERNAL_ERROR, no internal path leak", async () => {
    const svc = mockService();
    svc.searchTracks.mockRejectedValue(
      new Error("ENOENT: C:\\Users\\admin\\internal\\runtime\\missing"),
    );
    registerMusicIpcHandlers(svc);
    const r = (await handlerMap["music:search"](null, { keyword: "q" })) as any;
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("E_INTERNAL_ERROR");
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("C:\\Users");
    expect(serialized).not.toContain("internal/runtime");
  });

  it("MUSIC_GET_OPENAPI_CONFIG: returns null when unconfigured", async () => {
    const svc = mockService();
    svc.getOpenapiConfig.mockResolvedValue(null);
    registerMusicIpcHandlers(svc);
    const r = (await handlerMap["music:get-openapi-config"](null, undefined)) as any;
    expect(r.ok).toBe(true);
    expect(r.data).toBeNull();
  });

  it("MUSIC_GET_OPENAPI_CONFIG: masks privateKey in returned config", async () => {
    const svc = mockService();
    svc.getOpenapiConfig.mockResolvedValue({
      appId: "app-xyz",
      privateKey: "SUPER_SECRET_KEY",
    });
    registerMusicIpcHandlers(svc);
    const r = (await handlerMap["music:get-openapi-config"](null, undefined)) as any;
    expect(r.ok).toBe(true);
    expect(r.data.appId).toBe("app-xyz");
    expect(r.data.privateKey).toBe(""); // masked
    // Ensure the real key never crosses the IPC boundary
    expect(JSON.stringify(r)).not.toContain("SUPER_SECRET_KEY");
  });

  it("MUSIC_SAVE_OPENAPI_CONFIG: applies config and returns backend state", async () => {
    const svc = mockService();
    svc.applyOpenapiConfig.mockResolvedValue(undefined);
    svc.getBackendState.mockReturnValue("ready");
    registerMusicIpcHandlers(svc);
    const r = (await handlerMap["music:save-openapi-config"](null, {
      appId: "app-1",
      privateKey: "A".repeat(1600),
    })) as any;
    expect(r.ok).toBe(true);
    expect(r.data.backend).toBe("ready");
    expect(svc.applyOpenapiConfig).toHaveBeenCalledWith({
      appId: "app-1",
      privateKey: "A".repeat(1600),
    });
  });

  it("MUSIC_SAVE_OPENAPI_CONFIG: invalid config returns ok:false errorCode", async () => {
    const svc = mockService();
    const { MusicInputError } = await import("./types");
    svc.applyOpenapiConfig.mockRejectedValue(new MusicInputError("E_OPENAPI_CONFIG_INVALID", "appId required"));
    registerMusicIpcHandlers(svc);
    const r = (await handlerMap["music:save-openapi-config"](null, {
      appId: "",
      privateKey: "k",
    })) as any;
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("E_OPENAPI_CONFIG_INVALID");
  });
});
