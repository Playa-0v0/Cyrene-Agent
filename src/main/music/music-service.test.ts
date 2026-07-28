import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const { beginTool, checkTool, cancelTool, validateTool, searchTool, dailyTool, playTool, isRegistered, openExternal } = vi.hoisted(() => ({
  beginTool: vi.fn(),
  checkTool: vi.fn(),
  cancelTool: vi.fn(),
  validateTool: vi.fn(),
  searchTool: vi.fn(),
  dailyTool: vi.fn(),
  playTool: vi.fn(),
  isRegistered: vi.fn(),
  openExternal: vi.fn(),
}));

// Track each constructed client so logout tests can inspect the close() mock
// on the exact instance held by a given MusicService.
const clientInstances: Array<{ close: ReturnType<typeof vi.fn> }> = [];

vi.mock("./music-mcp-client", () => ({
  MusicMcpClient: vi.fn().mockImplementation(function () {
    const close = vi.fn();
    clientInstances.push({ close });
    return {
      connect: vi.fn(),
      verifyContractOnConnect: vi.fn().mockResolvedValue({ ok: true, missing: [], schemaMismatch: [] }),
      close,
      getRootPid: vi.fn().mockReturnValue(undefined),
      callDataTool: (name: string, args: unknown) => name === "cloud_music_search"
        ? searchTool(args)
        : name === "cloud_music_play"
          ? playTool(args)
          : dailyTool(args),
      callAuthTool: (name: string, args: unknown) => name === "cyrene_music_login_begin"
        ? beginTool(args)
        : name === "cyrene_music_login_check"
          ? checkTool(args)
          : name === "cyrene_music_validate_session"
            ? validateTool(args)
            : cancelTool(args),
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
  beginTool.mockReset(); checkTool.mockReset(); cancelTool.mockReset(); validateTool.mockReset();
  searchTool.mockReset(); dailyTool.mockReset();
  playTool.mockReset();
  playTool.mockImplementation((args: { id: string; type: string }) => `已发送播放指令: ${args.type} ${args.id}`);
  isRegistered.mockReset(); openExternal.mockReset();
  clientInstances.length = 0;
});

const PATHS = {
  vendorDir: "/repo/vendor/cloud-music-mcp",
  runtimeDir: "/userdata/music/netease/runtime",
  accountPath: "/userdata/music/netease/account.enc",
  resourceBaseDir: "/repo",
};

// Helper: build a fresh MusicService whose paths point at a temp directory
// so logout() can delete a real account.enc / cookies.json without leaking
// state across tests (the default PATHS use hard-coded /userdata paths).
async function freshServiceWithTmpPaths(): Promise<{ svc: MusicService; accountPath: string; runtimeDir: string; cleanup: () => Promise<void> }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "music-logout-"));
  const accountPath = path.join(tmp, "account.enc");
  const runtimeDir = path.join(tmp, "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  const svc = new MusicService({
    vendorDir: "/repo/vendor/cloud-music-mcp",
    runtimeDir,
    accountPath,
    resourceBaseDir: "/repo",
  });
  return {
    svc,
    accountPath,
    runtimeDir,
    cleanup: async () => { await fs.rm(tmp, { recursive: true, force: true }); },
  };
}

describe("MusicService", () => {
  it("uses the dedicated three-state validator instead of a fake QR session", async () => {
    validateTool.mockResolvedValue({ state: "valid", profile: { userId: "1", nickname: "alice" } });
    const s = new MusicService(PATHS);

    const result = await (s as unknown as { validateSessionThreeState(): Promise<unknown> }).validateSessionThreeState();

    expect(result).toEqual({ state: "valid", profile: { userId: "1", nickname: "alice" } });
    expect(validateTool).toHaveBeenCalledWith({});
    expect(checkTool).not.toHaveBeenCalled();
  });
  it("getDailyRecommendations rejects when backend not ready (stopped initial)", async () => {
    const s = new MusicService(PATHS);
    expect(s.getBackendState()).toBe("stopped");
    await expect(s.getDailyRecommendations("c1")).rejects.toThrow(/E_BACKEND_NOT_READY/);
  });

  it("searchTracks returns a set after start", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1", undefined, { resolutionRunId: "run-1" });
    expect(set.source).toBe("search");
    expect(set.provider).toBe("netease-cloud-music");
    expect(set.resolutionRunId).toBe("run-1");
    expect(set.presentedAt).toBeUndefined();
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

  it("searchTracks sends category song without forwarding local limit", async () => {
    searchTool.mockResolvedValue([]);
    const s = new MusicService(PATHS);
    await s.start();
    await s.searchTracks("q", "c1", 999);
    expect(searchTool).toHaveBeenCalledWith({ keyword: "q", category: "song" });
  });

  it("searchTracks applies the clamped limit after normalization", async () => {
    searchTool.mockResolvedValue(Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      name: `Song ${i + 1}`,
      artist: "Artist",
    })));
    const s = new MusicService(PATHS);
    await s.start();

    const set = await s.searchTracks("q", "c1", 3);

    expect(set.tracks.map((track) => track.id)).toEqual(["1", "2", "3"]);
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
    expect(s.getSelectionSet(set.setId, "c1")).not.toHaveProperty("presentedAt");
    s.markTracksPresented(set.setId, "c1", ["1"]);
    expect(s.getSelectionSet(set.setId, "c1")).toEqual(expect.objectContaining({
      presentedAt: expect.any(Number),
      presentedTrackIds: ["1"],
    }));
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
    await expect(s.playTrackFromUi("not-num")).rejects.toThrow(/E_INVALID_ID/);
  });

  it("playTrack preserves the MCP browser fallback state", async () => {
    playTool.mockResolvedValue(
      "⚠️ 未检测到客户端，已在浏览器中播放: https://music.163.com/#/song?id=123",
    );
    const s = new MusicService(PATHS);
    const r = await s.playTrackFromUi("123");
    expect(r.state).toBe("web_fallback");
    expect(playTool).toHaveBeenCalledWith({ id: "123", type: "song" });
  });

  it("playTrack dispatches through the MCP tool", async () => {
    const s = new MusicService(PATHS);
    const r = await s.playTrackFromUi("123");
    expect(r.state).toBe("dispatched");
    expect(r.resourceType).toBe("song");
    expect(r.resourceId).toBe("123");
    expect(playTool).toHaveBeenCalledWith({ id: "123", type: "song" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("plays a resolved candidate only inside the Agent run that fetched it", async () => {
    searchTool.mockResolvedValue([{ id: 123, name: "稻香", artist: "周杰伦" }]);
    isRegistered.mockResolvedValue(true);
    openExternal.mockResolvedValue(undefined);
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("稻香", "c1", 5, { resolutionRunId: "run-1", purpose: "play" });

    await expect(s.playTrack({
      provider: set.provider,
      setId: set.setId,
      trackId: "123",
      conversationId: "c1",
      runId: "run-2",
    })).rejects.toThrow(/E_TRACK_NOT_PLAYABLE/);

    await expect(s.playTrack({
      provider: set.provider,
      setId: set.setId,
      trackId: "123",
      conversationId: "c1",
      runId: "run-1",
    })).resolves.toEqual(expect.objectContaining({ state: "dispatched" }));
  });

  it("plays only the displayed subset across later Agent runs", async () => {
    searchTool.mockResolvedValue([
      { id: 123, name: "稻香", artist: "周杰伦" },
      { id: 456, name: "晴天", artist: "周杰伦" },
    ]);
    isRegistered.mockResolvedValue(true);
    openExternal.mockResolvedValue(undefined);
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("周杰伦", "c1", 5, { resolutionRunId: "run-1" });
    await s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: ["456"] });
    s.markTracksPresented(set.setId, "c1", ["456"]);

    await expect(s.playTrack({
      provider: set.provider,
      setId: set.setId,
      trackId: "123",
      conversationId: "c1",
      runId: "run-later",
    })).rejects.toThrow(/E_TRACK_NOT_PLAYABLE/);
    await expect(s.playTrack({
      provider: set.provider,
      setId: set.setId,
      trackId: "456",
      conversationId: "c1",
      runId: "run-later",
    })).resolves.toEqual(expect.objectContaining({ state: "dispatched" }));
  });

  it("rejects a provider or track id not contained in the real candidate set", async () => {
    searchTool.mockResolvedValue([{ id: 123, name: "稻香", artist: "周杰伦" }]);
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("稻香", "c1", 5, { resolutionRunId: "run-1", purpose: "play" });

    await expect(s.playTrack({ ...set, trackId: "999", runId: "run-1" } as never))
      .rejects.toThrow(/E_TRACK_NOT_IN_SET/);
    await expect(s.playTrack({
      provider: "qq-music",
      setId: set.setId,
      trackId: "123",
      conversationId: "c1",
      runId: "run-1",
    })).rejects.toThrow(/E_PROVIDER_MISMATCH/);
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

  // ── logout() ───────────────────────────────────────────────

  it("logout() on a fresh service cancels login, removes account file and runtime cookies, sets signed_out", async () => {
    cancelTool.mockResolvedValue({ ok: true, status: "cancelled" });
    beginTool.mockResolvedValue({ loginSessionId: "sess-1" });

    const { svc, accountPath, runtimeDir, cleanup } = await freshServiceWithTmpPaths();
    try {
      // Seed the vault with a fake encrypted account file (safeStorage is mocked as
      // unavailable so persist() is a no-op; we just drop the file on disk directly).
      await fs.writeFile(accountPath, "seed-account-blob");
      // And a runtime cookies file that logout() must scrub.
      const cookiesPath = path.join(runtimeDir, "cookies.json");
      await fs.writeFile(cookiesPath, JSON.stringify({ MUSIC_U: "old" }));

      // Track that the service was constructed with one MCP client whose close
      // we can later inspect.
      expect(clientInstances).toHaveLength(1);

      // Bring the service to "ready" and start a login session so the orchestrator
      // actually has a currentSessionId to cancel.
      await svc.start();
      await svc.beginLogin();
      expect(beginTool).toHaveBeenCalledTimes(1);

      await svc.logout();

      // 1. orchestrator.cancelLogin was called -> routed through MCP cancel RPC.
      expect(cancelTool).toHaveBeenCalledTimes(1);
      // 2. vault.delete removed account.enc.
      await expect(fs.stat(accountPath)).rejects.toThrow(/ENOENT/);
      // 3. runtime cookies.json removed.
      await expect(fs.stat(cookiesPath)).rejects.toThrow(/ENOENT/);
      // 4. accountState reports signed_out.
      expect(svc.getAccountState()).toBe("signed_out");
      expect(svc.getActiveProfile()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("logout() succeeds even when there is no account file", async () => {
    cancelTool.mockResolvedValue({ ok: true, status: "cancelled" });
    beginTool.mockResolvedValue({ loginSessionId: "sess-2" });

    const { svc, accountPath, cleanup } = await freshServiceWithTmpPaths();
    try {
      // Ensure no account.enc exists.
      await expect(fs.stat(accountPath)).rejects.toThrow(/ENOENT/);

      // Start the service and a login session so cancelLogin has something to cancel.
      await svc.start();
      await svc.beginLogin();

      await expect(svc.logout()).resolves.toBeUndefined();

      expect(cancelTool).toHaveBeenCalledTimes(1);
      expect(svc.getAccountState()).toBe("signed_out");
    } finally {
      await cleanup();
    }
  });
});
