// channels/bootstrap 生命周期测试。
// 核心回归点（Task 1）：createChannelsSubsystem 在构造期只注入 dispatcher 依赖，
// 不做任何初始化/启动 —— initialize / start / shutdown 必须显式调用。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", whenReady: async () => undefined },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

// init.ts 会被 mock：bootstrap 默认 lifecycle 直接委托到这三个函数
vi.mock("./init", () => ({
  initializeChannels: vi.fn(),
  startChannels: vi.fn(async () => undefined),
  shutdownChannels: vi.fn(async () => undefined),
}));

// dispatcher.ts 含未提交的用户修改，测试只依赖 setter（构造期被调用但不做实事）
vi.mock("./dispatcher", () => ({
  setDispatcherBuildAndRunAgent: vi.fn(),
  setDispatcherBroadcastChat: vi.fn(),
  setDispatcherLoadGeneralSettings: vi.fn(),
  setDispatcherLoadRecentHistory: vi.fn(),
  setDispatcherObserveExternalChat: vi.fn(),
  setDispatcherResolveBoundConversation: vi.fn(),
  setDispatcherLoadBoundConversationHistory: vi.fn(),
  setDispatcherAppendBoundConversationMessage: vi.fn(),
  setDispatcherSynthesizeTts: vi.fn(),
  formatChannelUserText: vi.fn(() => ""),
}));

// 避免拉起真实 tool registry（会级联 import RAG 等重依赖）
vi.mock("../orchestrator/tools/registry/tool-registry", () => ({
  toolRegistry: { getEnabledTools: () => [], getAllTools: () => [] },
}));
vi.mock("../orchestrator/tools/history-tools", () => ({
  indexConversationTurn: vi.fn(),
}));
vi.mock("../orchestrator/cyrene-agent", () => ({
  CyreneAgent: class {},
}));

// eslint-disable-next-line import/first
import { createChannelsSubsystem, type ChannelsSubsystemDeps } from "./bootstrap";
// eslint-disable-next-line import/first
import { initializeChannels, startChannels, shutdownChannels } from "./init";

function makeChannelsDeps(): ChannelsSubsystemDeps {
  return {
    agentRuntime: {} as ChannelsSubsystemDeps["agentRuntime"],
    ttsSynthesisService: {} as ChannelsSubsystemDeps["ttsSynthesisService"],
    getReactChatWindow: () => null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createChannelsSubsystem lifecycle", () => {
  it("does not initialize or start channels during construction", () => {
    const lifecycle = { initialize: vi.fn(), start: vi.fn(), shutdown: vi.fn() };
    const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
    expect(lifecycle.initialize).not.toHaveBeenCalled();
    expect(lifecycle.start).not.toHaveBeenCalled();
    subsystem.initialize();
    expect(lifecycle.initialize).toHaveBeenCalledOnce();
  });

  it("starts channels only after explicit start", async () => {
    const lifecycle = { initialize: vi.fn(), start: vi.fn(async () => undefined), shutdown: vi.fn() };
    const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
    await subsystem.start();
    expect(lifecycle.start).toHaveBeenCalledOnce();
  });

  it("forwards the abort signal to the lifecycle start", async () => {
    const lifecycle = { initialize: vi.fn(), start: vi.fn(async () => undefined), shutdown: vi.fn() };
    const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
    const controller = new AbortController();
    await subsystem.start(controller.signal);
    expect(lifecycle.start).toHaveBeenCalledOnce();
    expect(lifecycle.start).toHaveBeenCalledWith(controller.signal);
  });

  it("delegates shutdown to the lifecycle adapter", async () => {
    const lifecycle = { initialize: vi.fn(), start: vi.fn(async () => undefined), shutdown: vi.fn() };
    const subsystem = createChannelsSubsystem(makeChannelsDeps(), lifecycle);
    await subsystem.shutdown();
    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
  });

  it("defaults to the channels init module when no lifecycle adapter is provided", () => {
    const subsystem = createChannelsSubsystem(makeChannelsDeps());
    expect(initializeChannels).not.toHaveBeenCalled();
    expect(startChannels).not.toHaveBeenCalled();
    subsystem.initialize();
    expect(initializeChannels).toHaveBeenCalledOnce();
    void startChannels;
    void shutdownChannels;
  });
});
