import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAsrConfig: vi.fn(),
  createAsrStream: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  ipcMain: { on: vi.fn() },
}));

vi.mock("../asr/asr-config", () => ({
  getAsrConfig: mocks.getAsrConfig,
}));

vi.mock("../asr/asr-dispatcher", () => ({
  createAsrStream: mocks.createAsrStream,
}));

vi.mock("../orchestrator/vendors", () => ({
  buildVendorUrl: () => "https://example.invalid/chat",
  getAdapterForConfig: () => ({
    transport: "openai",
    buildRequest: () => ({ headers: {}, body: "{}" }),
    parseResponse: () => ({ text: "模型回复" }),
  }),
}));

vi.mock("../token-usage-store", () => ({
  recordRequest: vi.fn(),
  recordUsage: vi.fn(),
}));

import { endTurn, setCallSettings, setCallWindow, startCall, stopCall } from "./call-manager";

describe("call turn submission", () => {
  const sentStates: string[] = [];
  const sentErrors: string[] = [];

  beforeEach(() => {
    sentStates.length = 0;
    sentErrors.length = 0;
    mocks.getAsrConfig.mockReset();
    mocks.createAsrStream.mockReset();
    mocks.getAsrConfig.mockReturnValue({ engine: "mossland", apiKey: "test-key" });
    setCallWindow({
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, payload: { state?: string; message?: string }) => {
          if (payload.state) sentStates.push(payload.state);
          if (payload.message) sentErrors.push(payload.message);
        },
      },
    } as never);
    setCallSettings(
      () => ({ provider: "openai", baseUrl: "", model: "test", apiKey: "" }),
      () => ({ ttsEngine: "off" } as never),
      async () => "",
      async () => null,
    );
  });

  afterEach(() => {
    stopCall();
    setCallWindow(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("leaves LISTENING immediately while batch transcription is still stopping", async () => {
    let finishStop!: (text: string) => void;
    const stopResult = new Promise<string>((resolve) => { finishStop = resolve; });
    mocks.createAsrStream.mockReturnValue({
      start: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      stop: vi.fn(() => stopResult),
    });

    startCall();
    expect(sentStates.at(-1)).toBe("LISTENING");

    const turn = endTurn();
    expect(sentStates.at(-1)).toBe("THINKING");

    finishStop("");
    await turn;
  });

  it("returns to LISTENING when batch transcription produces no text", async () => {
    mocks.createAsrStream.mockReturnValue({
      start: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      stop: vi.fn(async () => ""),
    });

    startCall();
    await endTurn();

    expect(sentStates).toContain("THINKING");
    expect(sentStates.at(-1)).toBe("LISTENING");
  });

  it("returns to LISTENING when batch transcription fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValue("");
    mocks.createAsrStream.mockReturnValue({
      start: vi.fn(async () => undefined),
      sendAudio: vi.fn(),
      stop,
    });

    startCall();
    await endTurn();

    expect(sentStates).toContain("THINKING");
    expect(sentStates.at(-1)).toBe("LISTENING");
    consoleError.mockRestore();
  });

  it("sends the latest visible partial transcript when stop returns before a final result", async () => {
    let pushPartial!: (text: string) => void;
    mocks.createAsrStream.mockImplementation((_config, onPartial: (text: string) => void) => {
      pushPartial = onPartial;
      return {
        start: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        stop: vi.fn(() => undefined),
      };
    });
    setCallSettings(
      () => ({ provider: "openai", baseUrl: "", model: "test", apiKey: "test-key" }),
      () => ({ ttsEngine: "off" } as never),
      async () => "",
      async () => null,
    );
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    startCall();
    pushPartial("已经显示在通话窗口里的转写");
    await endTurn();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentErrors).toContain("TTS 未配置：请在设置中启用 TTS 引擎");
  });

  it("reports missing model config when the getter returns no api key", async () => {
    let pushPartial!: (text: string) => void;
    mocks.createAsrStream.mockImplementation((_config, onPartial: (text: string) => void) => {
      pushPartial = onPartial;
      return {
        start: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        stop: vi.fn(() => undefined),
      };
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    startCall();
    pushPartial("用户语音");
    await endTurn();

    // 模型 getter 未返回 apiKey → 不发 LLM 请求，直接报配置缺失
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentErrors.some((msg) => msg.includes("模型配置缺失"))).toBe(true);
  });
});
