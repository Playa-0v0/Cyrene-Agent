import { describe, it, expect, beforeEach, vi } from "vitest";

const { beginTool, checkTool, cancelTool, searchTool, dailyTool, isRegistered, openExternal } = vi.hoisted(() => ({
  beginTool: vi.fn(),
  checkTool: vi.fn(),
  cancelTool: vi.fn(),
  searchTool: vi.fn(),
  dailyTool: vi.fn(),
  isRegistered: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("./music-mcp-client", () => ({
  MusicMcpClient: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn(),
      verifyContractOnConnect: vi.fn().mockResolvedValue({ ok: true, missing: [], schemaMismatch: [] }),
      close: vi.fn(),
      getRootPid: vi.fn().mockReturnValue(undefined),
      callDataTool: (name: string, args: unknown) => name === "cloud_music_search" ? searchTool(args) : dailyTool(args),
      callAuthTool: (name: string, args: unknown) => name === "cyrene_music_login_begin" ? beginTool(args) : name === "cyrene_music_login_check" ? checkTool(args) : cancelTool(args),
    };
  }),
}));

vi.mock("./protocol-detector", () => ({
  ProtocolDetector: vi.fn().mockImplementation(function () { return { isRegistered, invalidate: vi.fn() }; }),
}));

vi.mock("electron", () => ({
  shell: { openExternal },
  app: { isPackaged: false, getAppPath: () => "/repo", getPath: () => "/userdata" },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "{}",
  },
}));

import { MusicService } from "./music-service";

beforeEach(() => {
  beginTool.mockReset(); checkTool.mockReset(); cancelTool.mockReset();
  searchTool.mockReset(); dailyTool.mockReset();
  isRegistered.mockReset(); openExternal.mockReset();
});

const PATHS = {
  vendorDir: "/repo/vendor/cloud-music-mcp",
  runtimeDir: "/userdata/music/netease/runtime",
  accountPath: "/userdata/music/netease/account.enc",
  resourceBaseDir: "/repo",
};

describe("MusicService", () => {
  it("getDailyRecommendations rejects when backend not ready (stopped initial)", async () => {
    const s = new MusicService(PATHS);
    expect(s.getBackendState()).toBe("stopped");
    await expect(s.getDailyRecommendations("c1")).rejects.toThrow(/E_BACKEND_NOT_READY/);
  });

  it("searchTracks returns a set after start", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1");
    expect(set.source).toBe("search");
    expect(set.tracks).toHaveLength(1);
    expect(set.tracks[0].artists).toEqual(["Y"]);
  });

  it("searchTracks rejects keyword longer than 100 chars", async () => {
    const s = new MusicService(PATHS);
    await s.start();
    await expect(s.searchTracks("x".repeat(101), "c1")).rejects.toThrow(/E_INVALID_KEYWORD_TOO_LONG/);
  });

  it("searchTracks rejects empty keyword", async () => {
    const s = new MusicService(PATHS);
    await s.start();
    await expect(s.searchTracks("   ", "c1")).rejects.toThrow(/E_INVALID_KEYWORD_EMPTY/);
  });

  it("searchTracks clamps limit to 20", async () => {
    searchTool.mockResolvedValue({ success: true, items: [] });
    const s = new MusicService(PATHS);
    await s.start();
    await s.searchTracks("q", "c1", 999);
    expect(searchTool).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it("presentTracks validates trackIds belong to the set", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1");
    await expect(s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: ["999"] }))
      .rejects.toThrow(/E_TRACK_NOT_IN_SET/);
    const ok = await s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: ["1"] });
    expect(ok.cardRef).toContain(set.setId);
  });

  it("presentTracks limits to 5 selected", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1");
    await expect(s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: ["1", "1", "1", "1", "1", "1"] }))
      .rejects.toThrow(/E_TOO_MANY_SELECTED/);
  });

  it("presentTracks validates reason length", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1");
    await expect(s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: ["1"], reasons: ["x".repeat(51)] }))
      .rejects.toThrow(/E_REASON_TOO_LONG/);
  });

  it("playTrack rejects non-numeric id", async () => {
    const s = new MusicService(PATHS);
    await expect(s.playTrack("not-num")).rejects.toThrow(/E_INVALID_ID/);
  });

  it("playTrack returns client_unavailable when protocol missing", async () => {
    isRegistered.mockResolvedValue(false);
    const s = new MusicService(PATHS);
    const r = await s.playTrack("123");
    expect(r.state).toBe("client_unavailable");
    expect(r.errorCode).toBe("E_PROTOCOL_NOT_REGISTERED");
  });

  it("playTrack dispatches when protocol registered", async () => {
    isRegistered.mockResolvedValue(true);
    openExternal.mockResolvedValue(undefined);
    const s = new MusicService(PATHS);
    const r = await s.playTrack("123");
    expect(r.state).toBe("dispatched");
    expect(r.resourceType).toBe("song");
    expect(r.resourceId).toBe("123");
  });

  // ── New spec-required methods ──────────────────────────────

  it("getSelectionSet retrieves set by id and conversationId", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1");
    expect(s.getSelectionSet(set.setId, "c1")).toEqual(set);
    expect(s.getSelectionSet(set.setId, "c2")).toBeNull();
  });

  it("getLoginFlowState returns orchestrator flow state", () => {
    const s = new MusicService(PATHS);
    expect(s.getLoginFlowState()).toBe("idle");
  });

  it("getActiveProfile returns null before login", () => {
    const s = new MusicService(PATHS);
    expect(s.getActiveProfile()).toBeNull();
  });

  it("event listeners return unsubscribe functions", () => {
    const s = new MusicService(PATHS);
    const fn = () => {};
    const unsub = s.onBackendStateChange(fn);
    unsub();
    // No assertion needed — just verifying no throw
    expect(true).toBe(true);
  });

  it("shutdown returns a MusicShutdownReport", async () => {
    const s = new MusicService(PATHS);
    const report = await s.shutdown();
    expect(report).toEqual({
      rootProcessPid: undefined,
      transportClosed: true,
      processTreeExited: true,  // no live PID to check
      runtimeRemoved: true,
    });
  });

  it("shutdown is idempotent", async () => {
    const s = new MusicService(PATHS);
    const r1 = await s.shutdown();
    const r2 = await s.shutdown();
    expect(r1).toEqual(r2);
  });
});