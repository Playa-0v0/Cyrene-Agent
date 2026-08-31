import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./music-service", () => ({
  MusicService: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue({
        rootProcessPid: undefined,
        transportClosed: true,
        processTreeExited: true,
        runtimeRemoved: true,
      }),
      getRootPid: vi.fn().mockReturnValue(undefined),
    };
  }),
}));

const ipcDisposer = vi.fn();
vi.mock("./ipc-handlers", () => ({
  registerMusicIpcHandlers: vi.fn(() => ipcDisposer),
}));

const mockTools = [
  { id: "music_a" },
  { id: "music_b" },
];
vi.mock("../orchestrator/tools/music-tools", () => ({
  buildMusicTools: vi.fn(() => mockTools),
}));

const registered: string[] = [];
const unregistered: string[] = [];
vi.mock("../orchestrator/tool-registry", () => ({
  toolRegistry: {
    register: (t: { id: string }) => { registered.push(t.id); },
    unregister: (id: string) => { unregistered.push(id); },
  },
}));

import { bootstrapMusicService } from "./bootstrap";
import { MusicService } from "./music-service";
import { registerMusicIpcHandlers } from "./ipc-handlers";
import { buildMusicTools } from "../orchestrator/tools/music-tools";

const PATHS = {
  runtimeDir: "/repo/runtime",
  accountPath: "/repo/account.enc",
  resourceBaseDir: "/repo",
};

beforeEach(() => {
  registered.length = 0;
  unregistered.length = 0;
  vi.mocked(MusicService).mockClear();
  vi.mocked(registerMusicIpcHandlers).mockClear();
  vi.mocked(buildMusicTools).mockClear();
  ipcDisposer.mockClear();
});

describe("bootstrapMusicService", () => {
  it("creates a MusicService and registers IPC + tools without starting the backend", () => {
    const b = bootstrapMusicService(PATHS);
    expect(MusicService).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registerMusicIpcHandlers)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildMusicTools)).toHaveBeenCalledTimes(1);
    expect(registered).toEqual(["music_a", "music_b"]);
    expect(b.service.start).not.toHaveBeenCalled();
    expect(b.isShuttingDown()).toBe(false);
  });

  it("shutdown calls service.shutdown and disposes IPC + tools", async () => {
    const b = bootstrapMusicService(PATHS);
    const report = await b.shutdown();
    expect(b.service.shutdown).toHaveBeenCalledTimes(1);
    expect(ipcDisposer).toHaveBeenCalledTimes(1);
    expect(unregistered).toEqual(["music_a", "music_b"]);
    expect(report).toEqual({
      rootProcessPid: undefined,
      transportClosed: true,
      processTreeExited: true,
      runtimeRemoved: true,
    });
  });

  it("shutdown is idempotent (second call is a no-op)", async () => {
    const b = bootstrapMusicService(PATHS);
    await b.shutdown();
    unregistered.length = 0;
    ipcDisposer.mockClear();
    const r2 = await b.shutdown();
    expect(b.service.shutdown).toHaveBeenCalledTimes(1);
    expect(ipcDisposer).not.toHaveBeenCalled();
    expect(unregistered).toHaveLength(0);
    expect(r2.runtimeRemoved).toBe(true);
  });
});
