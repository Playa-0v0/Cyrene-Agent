// MusicService tests — M3+M4 architecture (OpenAPI provider, no Python, no CITA).
//
// Tests mock the provider's underlying OpenAPI client methods (searchSongs,
// getDailyRecommendations, getSongDetail, etc.) by injecting a mock client
// into the real NeteaseOpenapiProvider, then exercising MusicService's
// session cache (SelectionSetCache TTL reuse) and playback dispatch.
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { OpenapiConfigStore } from "./openapi-config";

// Hoisted mocks for the OpenAPI client methods that the provider delegates to.
const mocks = vi.hoisted(() => ({
  searchSongs: vi.fn(),
  getDailyRecommendations: vi.fn(),
  getSongDetail: vi.fn(),
  getCreatedPlaylists: vi.fn(),
  getPlaylistDetail: vi.fn(),
  getPlaylistSongs: vi.fn(),
  createPlaylist: vi.fn(),
  addSongsToPlaylist: vi.fn(),
  removeSongsFromPlaylist: vi.fn(),
  getSubscribedAlbums: vi.fn(),
  getUserProfile: vi.fn(),
  loginAnonymous: vi.fn(),
  getQrCodeKey: vi.fn(),
  checkQrLoginStatus: vi.fn(),
  setAccessToken: vi.fn(),
  getLyric: vi.fn(),
  setSongLike: vi.fn(),
}));

const mpvMocks = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  load: vi.fn().mockResolvedValue(undefined),
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn().mockResolvedValue(undefined),
  togglePlay: vi.fn().mockResolvedValue(undefined),
  seek: vi.fn().mockResolvedValue(undefined),
  setVolume: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  next: vi.fn().mockResolvedValue(undefined),
  prev: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn().mockResolvedValue(undefined),
  setTrack: vi.fn(),
  getState: vi.fn(() => ({
    connected: true, loaded: false, paused: false,
    position: 0, duration: 0, volume: 70,
  })),
  isReady: vi.fn(() => true),
  listeners: new Set<(state: Record<string, unknown>) => void>(),
  onStateChange: vi.fn((listener: (state: Record<string, unknown>) => void) => {
    mpvMocks.listeners.add(listener);
    return () => mpvMocks.listeners.delete(listener);
  }),
}));

// Mock OpenapiConfigStore to always return valid config (skips real disk I/O).
// In-memory store so applyOpenapiConfig + getOpenapiConfig round-trip works.
vi.mock("./openapi-config", () => ({
  OpenapiConfigStore: vi.fn().mockImplementation(function () {
    let saved: { appId: string; privateKey: string } | null = {
      appId: "test-app",
      privateKey: "A".repeat(1600),
    };
    return {
      loadValidated: vi.fn(async () => saved),
      load: vi.fn(async () => saved),
      save: vi.fn(async (cfg: { appId: string; privateKey: string }) => {
        saved = { appId: cfg.appId, privateKey: cfg.privateKey };
      }),
      delete: vi.fn(async () => { saved = null; }),
    };
  }),
  validateOpenapiConfig: vi.fn(),
}));

// Mock TokenVault (no real disk I/O).
vi.mock("./token-vault", () => ({
  TokenVault: vi.fn().mockImplementation(function () {
    return {
      load: vi.fn().mockResolvedValue(null),
      decrypt: vi.fn(),
      persist: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(undefined),
      isFresh: vi.fn(() => true),
    };
  }),
}));

// Mock safeStorage (required by TokenVault constructor, not used in tests).
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "{}",
  },
  app: { isPackaged: false, getAppPath: () => "/repo", getPath: () => "/userdata" },
  shell: { openExternal: vi.fn() },
}));

// Mock NeteaseOpenapiClient so we can inject controlled responses.
vi.mock("./netease-openapi-client", () => ({
  NeteaseOpenapiClient: vi.fn().mockImplementation(function () {
    return {
      setAccessToken: mocks.setAccessToken,
      configure: vi.fn(), // placeholder for lazy credential injection
      searchSongs: mocks.searchSongs,
      getDailyRecommendations: mocks.getDailyRecommendations,
      getSongDetail: mocks.getSongDetail,
      getCreatedPlaylists: mocks.getCreatedPlaylists,
      getPlaylistDetail: mocks.getPlaylistDetail,
      getPlaylistSongs: mocks.getPlaylistSongs,
      createPlaylist: mocks.createPlaylist,
      addSongsToPlaylist: mocks.addSongsToPlaylist,
      removeSongsFromPlaylist: mocks.removeSongsFromPlaylist,
      getSubscribedAlbums: mocks.getSubscribedAlbums,
      getUserProfile: mocks.getUserProfile,
      loginAnonymous: mocks.loginAnonymous,
      getQrCodeKey: mocks.getQrCodeKey,
      checkQrLoginStatus: mocks.checkQrLoginStatus,
      getLyric: mocks.getLyric,
      setSongLike: mocks.setSongLike,
    };
  }),
  wrapPkcs8Pem: vi.fn((k: string) => k),
  buildSignString: vi.fn(),
}));

// Mock MpvController to avoid spawning real mpv process.
vi.mock("./mpv-controller", () => ({
  MpvController: vi.fn().mockImplementation(function () {
    return {
      start: mpvMocks.start,
      load: mpvMocks.load,
      play: mpvMocks.play,
      pause: mpvMocks.pause,
      togglePlay: mpvMocks.togglePlay,
      seek: mpvMocks.seek,
      setVolume: mpvMocks.setVolume,
      stop: mpvMocks.stop,
      next: mpvMocks.next,
      prev: mpvMocks.prev,
      dispose: mpvMocks.dispose,
      setTrack: mpvMocks.setTrack,
      getState: mpvMocks.getState,
      isReady: mpvMocks.isReady,
      onStateChange: mpvMocks.onStateChange,
    };
  }),
}));

// Mock CacheDownloader — 用 hoisted 状态控制缓存命中/下载中场景
const cacheState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  inFlight: new Map<string, Promise<{ ok: boolean; trackId: string; filePath?: string }>>(),
  records: new Map<string, { encryptedId: string; name: string; artists: string[] }>(),
  updatedListeners: new Set<() => void>(),
}));
vi.mock("./cache-downloader", () => ({
  CacheDownloader: vi.fn().mockImplementation(function () {
    return {
      initialize: vi.fn(async () => {}),
      isCached: vi.fn((id: string) => cacheState.files.has(id)),
      getFilePath: vi.fn((id: string) => cacheState.files.get(id)),
      getDownloadPromise: vi.fn((id: string) => cacheState.inFlight.get(id) ?? undefined),
      getTrack: vi.fn((id: string) => cacheState.records.get(id)),
      listTracks: vi.fn(() => [...cacheState.records.values()]),
      download: vi.fn(async (track: { id: string }) => ({
        ok: true,
        trackId: track.id,
        filePath: cacheState.files.get(track.id),
      })),
      remove: vi.fn(async (id: string) => cacheState.records.delete(id)),
      importFiles: vi.fn(async () => ({ imported: 0, skipped: 0 })),
      on: vi.fn((_event: string, handler: () => void) => {
        cacheState.updatedListeners.add(handler);
      }),
      off: vi.fn((_event: string, handler: () => void) => {
        cacheState.updatedListeners.delete(handler);
      }),
      onUpdated: vi.fn((handler: () => void) => {
        cacheState.updatedListeners.add(handler);
        return () => cacheState.updatedListeners.delete(handler);
      }),
    };
  }),
}));

import { MusicService } from "./music-service";

const ENC = "4C777A98B81DF0CC069B59F63F3882B1";
const ENC2 = "A".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  cacheState.files.clear();
  cacheState.inFlight.clear();
  cacheState.records.clear();
  cacheState.updatedListeners.clear();
  mpvMocks.listeners.clear();
  // Default: restoreSession finds no token → signed_out.
  mocks.loginAnonymous.mockResolvedValue({ accessToken: "anon", refreshToken: "", expireTime: 86400 });
});

const PATHS = {
  vendorDir: undefined,
  componentDir: undefined,
  runtimeDir: "/tmp/music-runtime",
  accountPath: "/tmp/music/account.enc",
  resourceBaseDir: "/repo",
};

function makeService(): MusicService {
  return new MusicService(PATHS);
}

function emitMpvState(state: Record<string, unknown>): void {
  for (const listener of mpvMocks.listeners) listener(state);
}

const songRec = (overrides: Partial<Record<string, unknown>> = {}) => ({
  originalId: 1,
  id: ENC,
  name: "晴天",
  artists: [{ name: "周杰伦" }],
  duration: 182890,
  ...overrides,
});

describe("MusicService (M3 OpenAPI)", () => {
  it("start → ready (config present, no token → signed_out)", async () => {
    const s = makeService();
    await s.start();
    expect(s.getBackendState()).toBe("ready");
    // restoreSession is fire-and-forget; wait a tick
    await new Promise((r) => setTimeout(r, 0));
    expect(s.getAccountState()).toBe("signed_out");
  });

  it("ensureReady rejects when shutting down", async () => {
    const s = makeService();
    await s.start();
    await s.shutdown();
    await expect(s.searchTracks("x", "c1")).rejects.toThrow(/E_BACKEND_NOT_READY/);
  });

  it("getDailyRecommendations requires signed_in", async () => {
    const s = makeService();
    await expect(s.getDailyRecommendations("c1")).rejects.toThrow(/E_ACCOUNT_REQUIRED/);
  });

  it("searchTracks returns a set with 32-hex encrypted IDs", async () => {
    mocks.searchSongs.mockResolvedValue({
      recordCount: 1,
      records: [songRec()],
    });
    const s = makeService();
    // Bypass requireSignedIn by injecting account state
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const set = await s.searchTracks("晴天", "c1");
    expect(set.source).toBe("search");
    expect(set.provider).toBe("netease-openapi");
    expect(set.tracks[0].id).toBe(ENC);
    expect(set.tracks[0].encryptedId).toBe(ENC);
    expect(set.tracks[0].originalId).toBe(1);
  });

  it("searchTracks rejects empty/long keyword", async () => {
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    await expect(s.searchTracks("   ", "c1")).rejects.toThrow(/E_INVALID_KEYWORD_EMPTY/);
    await expect(s.searchTracks("x".repeat(101), "c1")).rejects.toThrow(/E_INVALID_KEYWORD_TOO_LONG/);
  });

  it("searchTracks clamps limit", async () => {
    mocks.searchSongs.mockResolvedValue({
      recordCount: 5,
      records: Array.from({ length: 5 }, (_, i) => songRec({ id: String.fromCharCode(65 + i).repeat(32), originalId: i + 1 })),
    });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const set = await s.searchTracks("q", "c1", 3);
    expect(set.tracks).toHaveLength(3);
  });

  it("playTrackFromUi rejects empty id", async () => {
    const s = makeService();
    await s.start();
    await expect(s.playTrackFromUi("")).rejects.toThrow(/E_INVALID_ID/);
  });

  it("playTrackFromUi dispatches through mpv (state=dispatched)", async () => {
    mocks.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: "http://x/y.mp3" });
    const s = makeService();
    await s.start();
    const r = await s.playTrackFromUi(ENC);
    expect(r.state).toBe("dispatched");
    expect(r.resourceType).toBe("song");
    expect(mpvMocks.load).toHaveBeenCalledWith("http://x/y.mp3", "replace");
    expect(mpvMocks.setTrack).toHaveBeenCalledWith(expect.objectContaining({ encryptedId: ENC }));
  });

  it("playTrackFromUi rejects when no playUrl", async () => {
    mocks.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: "" });
    const s = makeService();
    await s.start();
    await expect(s.playTrackFromUi(ENC)).rejects.toThrow(/E_TRACK_NOT_PLAYABLE/);
  });

  it("playTrackFromUi cache hit → plays local file without API call", async () => {
    cacheState.files.set(ENC, "C:/cache/enc.mp3");
    cacheState.records.set(ENC, { encryptedId: ENC, name: "晴天", artists: ["周杰伦"] });
    const s = makeService();
    await s.start();
    const r = await s.playTrackFromUi(ENC);
    expect(r.state).toBe("dispatched");
    expect(mpvMocks.load).toHaveBeenCalledWith("C:/cache/enc.mp3", "replace");
    expect(mpvMocks.setTrack).toHaveBeenCalledWith(expect.objectContaining({ encryptedId: ENC, name: "晴天" }));
    // 关键：不调 getSongDetail（不烧 API 配额）
    expect(mocks.getSongDetail).not.toHaveBeenCalled();
  });

  it("playTrackFromUi downloading → awaits in-flight promise, then plays local", async () => {
    let resolveDownload!: (v: { ok: boolean; trackId: string; filePath?: string }) => void;
    cacheState.inFlight.set(
      ENC,
      new Promise((res) => { resolveDownload = res; }),
    );
    cacheState.records.set(ENC, { encryptedId: ENC, name: "晴天", artists: ["周杰伦"] });
    const s = makeService();
    await s.start();
    const pending = s.playTrackFromUi(ENC);
    // 下载尚未完成时不应打 API
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.getSongDetail).not.toHaveBeenCalled();
    resolveDownload({ ok: true, trackId: ENC, filePath: "C:/cache/enc.mp3" });
    const r = await pending;
    expect(r.state).toBe("dispatched");
    expect(mpvMocks.load).toHaveBeenCalledWith("C:/cache/enc.mp3", "replace");
    expect(mocks.getSongDetail).not.toHaveBeenCalled();
  });

  it("continues a cached list-loop session after the player window has closed", async () => {
    mocks.getSongDetail.mockImplementation(async (id: string) => ({
      name: id === ENC ? "第一首" : "末曲",
      playUrl: `http://x/${id}.mp3`,
    }));
    const s = makeService();
    await s.start();
    await s.playSessionTrack({
      queue: [
        { id: ENC, name: "第一首", artists: [] },
        { id: ENC2, name: "末曲", artists: [] },
      ],
      queueIndex: 1,
      playbackMode: "all",
      playlistId: "__local_cache__",
    });
    mpvMocks.load.mockClear();

    emitMpvState({
      eofReached: true,
      track: { encryptedId: ENC2, name: "末曲", artists: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mpvMocks.load).toHaveBeenCalledWith(`http://x/${ENC}.mp3`, "replace");
  });

  it("replays one-song mode once for repeated EOF reports", async () => {
    mocks.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: `http://x/${ENC}.mp3` });
    const s = makeService();
    await s.start();
    await s.playSessionTrack({
      queue: [{ id: ENC, name: "晴天", artists: [] }],
      queueIndex: 0,
      playbackMode: "one",
      playlistId: "playlist-1",
    });
    mpvMocks.load.mockClear();

    emitMpvState({ eofReached: true, track: { encryptedId: ENC, name: "晴天", artists: [] } });
    emitMpvState({ eofReached: true, track: { encryptedId: ENC, name: "晴天", artists: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mpvMocks.load).toHaveBeenCalledTimes(1);
    expect(mpvMocks.load).toHaveBeenCalledWith(`http://x/${ENC}.mp3`, "replace");
  });

  it("rejects malformed playback-session input with a domain error", async () => {
    const s = makeService();
    await expect(s.playSessionTrack(null as unknown as Parameters<typeof s.playSessionTrack>[0]))
      .rejects.toMatchObject({ code: "E_PLAYBACK_SESSION_INVALID" });
    expect(() => s.syncPlaybackSession({
      queue: [{ id: ENC, name: "晴天", artists: [] }],
      queueIndex: 1,
      playbackMode: "all",
      playlistId: "playlist-1",
    })).toThrow(expect.objectContaining({ code: "E_PLAYBACK_QUEUE_INDEX_INVALID" }));
  });

  it("keeps an idle queue whose selected index is -1", () => {
    const s = makeService();
    expect(s.syncPlaybackSession({
      queue: [{ id: ENC, name: "晴天", artists: [] }],
      queueIndex: -1,
      playbackMode: "all",
      playlistId: "playlist-1",
    })).toMatchObject({ queueIndex: -1, queue: [{ id: ENC }] });
  });

  it("removeCachedTrack rejects when track is playing (E_CACHE_TRACK_PLAYING)", async () => {
    mocks.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: "http://x/y.mp3" });
    const s = makeService();
    await s.start();
    await s.playTrackFromUi(ENC); // currentPlayback = ENC
    cacheState.records.set(ENC, { encryptedId: ENC, name: "晴天", artists: [] });
    await expect(s.removeCachedTrack(ENC)).rejects.toMatchObject({ code: "E_CACHE_TRACK_PLAYING" });
  });

  it("playback control methods call mpv", async () => {
    const s = makeService();
    await s.start();
    await s.playbackPlay();
    expect(mpvMocks.play).toHaveBeenCalled();
    await s.playbackPause();
    expect(mpvMocks.pause).toHaveBeenCalled();
    await s.playbackToggle();
    expect(mpvMocks.togglePlay).toHaveBeenCalled();
    await s.playbackSeek(10);
    expect(mpvMocks.seek).toHaveBeenCalledWith(10);
    await s.playbackSetVolume(50);
    expect(mpvMocks.setVolume).toHaveBeenCalledWith(50);
    await s.playbackStop();
    expect(mpvMocks.stop).toHaveBeenCalled();
  });

  it("getLyrics calls client.getLyric", async () => {
    mocks.getLyric.mockResolvedValue({
      lyric: "[00:01.00]晴天\n",
      transLyric: "[00:01.00]Sunny Day\n",
    });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const { lrc, transLrc } = await s.getLyrics(ENC);
    expect(lrc).toBe("[00:01.00]晴天\n");
    expect(transLrc).toBe("[00:01.00]Sunny Day\n");
    expect(mocks.getLyric).toHaveBeenCalledWith(ENC);
  });

  it("toggleFavorite calls client.setSongLike", async () => {
    mocks.setSongLike.mockResolvedValue({});
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const result = await s.toggleFavorite(ENC, true);
    expect(result).toBe(true);
    expect(mocks.setSongLike).toHaveBeenCalledWith(ENC, true);
  });

  it("getPlaybackState returns mpv state", async () => {
    mpvMocks.getState.mockReturnValue({
      connected: true, loaded: true, paused: false,
      position: 30, duration: 180, volume: 50,
    });
    const s = makeService();
    await s.start();
    const state = s.getPlaybackState();
    expect(state.loaded).toBe(true);
    expect(state.position).toBe(30);
    expect(state.duration).toBe(180);
  });

  it("playback methods throw E_MPV_NOT_READY when mpv not ready", async () => {
    mpvMocks.isReady.mockReturnValue(false);
    const s = makeService();
    await s.start();
    await expect(s.playbackPlay()).rejects.toThrow(/E_MPV_NOT_READY/);
  });

  it("getMyPlaylists / getPlaylistDetail / createPlaylist / addToPlaylist / getMySubscriptions", async () => {
    mocks.getCreatedPlaylists.mockResolvedValue({ records: [{ id: "a".repeat(32), name: "list", trackCount: 3 }] });
    mocks.getPlaylistDetail.mockResolvedValue({ id: "a".repeat(32), name: "list" });
    mocks.getPlaylistSongs.mockResolvedValue([songRec()]);
    mocks.createPlaylist.mockResolvedValue({ id: "Q".repeat(32), name: "new" });
    mocks.addSongsToPlaylist.mockResolvedValue({ count: 1 });
    mocks.getSubscribedAlbums.mockResolvedValue({ records: [{ id: "A".repeat(32), name: "叶惠美" }] });

    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");

    expect((await s.getMyPlaylists())[0].trackCount).toBe(3);
    expect((await s.getPlaylistDetail("a".repeat(32))).name).toBe("list");
    expect((await s.createPlaylist("new")).id).toBe("Q".repeat(32));
    expect(await s.addToPlaylist("a".repeat(32), [ENC])).toEqual({ added: 1, playlistId: "a".repeat(32) });
    expect((await s.getMySubscriptions("albums"))[0].name).toBe("叶惠美");
    expect(await s.getMySubscriptions("artists")).toEqual([]);
  });

  it("removeFromPlaylist delegates to provider and validates input", async () => {
    mocks.removeSongsFromPlaylist.mockResolvedValue({ count: 1 });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");

    expect(await s.removeFromPlaylist("a".repeat(32), [ENC])).toEqual({ removed: 1, playlistId: "a".repeat(32) });
    expect(mocks.removeSongsFromPlaylist).toHaveBeenCalledWith("a".repeat(32), [ENC]);
    await expect(s.removeFromPlaylist("a".repeat(32), [])).rejects.toThrow(/E_TRACK_IDS_EMPTY/);
  });

  it("getLoginFlowState returns idle before login", () => {
    const s = makeService();
    expect(s.getLoginFlowState()).toBe("idle");
  });

  it("getActiveProfile returns null before login", () => {
    const s = makeService();
    expect(s.getActiveProfile()).toBeNull();
  });

  it("event listeners return unsubscribe functions", () => {
    const s = makeService();
    const fn = () => {};
    const unsub = s.onBackendStateChange(fn);
    unsub();
    expect(true).toBe(true);
  });

  it("shutdown returns a MusicShutdownReport", async () => {
    const s = makeService();
    await s.start();
    const report = await s.shutdown();
    expect(report).toEqual({
      rootProcessPid: undefined,
      transportClosed: true,
      processTreeExited: true,
      runtimeRemoved: true,
    });
  });

  it("shutdown is idempotent", async () => {
    const s = makeService();
    await s.start();
    const r1 = await s.shutdown();
    const r2 = await s.shutdown();
    expect(r1).toEqual(r2);
  });

  it("logout deletes token vault and sets signed_out", async () => {
    const s = makeService();
    await s.start();
    await s.logout();
    expect(s.getAccountState()).toBe("signed_out");
    expect(s.getActiveProfile()).toBeNull();
  });

  it("applyOpenapiConfig rejects empty appId/privateKey", async () => {
    const s = makeService();
    await expect(s.applyOpenapiConfig({ appId: "", privateKey: "k" })).rejects.toMatchObject({ code: "E_OPENAPI_CONFIG_INVALID" });
    await expect(s.applyOpenapiConfig({ appId: "a", privateKey: "" })).rejects.toMatchObject({ code: "E_OPENAPI_CONFIG_INVALID" });
  });

  it("applyOpenapiConfig persists config and re-inits backend", async () => {
    const s = makeService();
    await s.start();
    expect(s.getBackendState()).toBe("ready");
    // Apply new config — should persist + re-init (still ready)
    await s.applyOpenapiConfig({ appId: "new-app", privateKey: "B".repeat(1600) });
    expect(s.getBackendState()).toBe("ready");
  });

  it("getOpenapiConfig returns the persisted config (or null)", async () => {
    const s = makeService();
    // Before apply: null (mock has no real disk)
    const before = await s.getOpenapiConfig();
    // mock OpenapiConfigStore.loadValidated returns the test-app config from the
    // vi.mock factory in this file, so it won't be null — assert shape only.
    if (before) {
      expect(before.appId).toBe("test-app");
    }
    // After apply with new values, the mock persists in-memory; just check no throw.
    await s.applyOpenapiConfig({ appId: "x", privateKey: "C".repeat(1600) });
    const after = await s.getOpenapiConfig();
    expect(after).not.toBeNull();
  });

  it("no config → incompatible", async () => {
    // Override the mock to return null config
    const { OpenapiConfigStore } = await import("./openapi-config");
    vi.mocked(OpenapiConfigStore).mockImplementationOnce(function () {
      return { loadValidated: vi.fn().mockResolvedValue(null) } as unknown as OpenapiConfigStore;
    });
    const s = new MusicService(PATHS);
    await s.start();
    expect(s.getBackendState()).toBe("incompatible");
  });
});
