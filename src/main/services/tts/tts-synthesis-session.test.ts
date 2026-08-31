import path from "node:path";
import * as os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "../../settings/general-settings";
import { loadGeneralSettings } from "../../settings/settings-facade";
import * as chatsStore from "../../chats/chats-store";
import * as ttsCache from "../../tts/tts-cache";
import { synthesize as mosslandSynthesize } from "../../tts/mossland-engine";
import { createTtsSynthesisService } from "./tts-synthesis-service";
import type { StartTtsRequest } from "../../../shared/tts-session";

vi.mock("../../settings/settings-facade", () => ({
  loadGeneralSettings: vi.fn(),
}));

vi.mock("../../chats/chats-store", () => ({
  getSession: vi.fn(),
}));

vi.mock("../../tts/tts-cache", () => ({
  appendMinimaxTtsLog: vi.fn(),
  appendGptsovitsTtsLog: vi.fn(),
  appendCustomCloudTtsLog: vi.fn(),
  appendMimoTtsLog: vi.fn(),
  buildTtsCacheKey: vi.fn(() => "minimax-test-key"),
  buildGptsovitsCacheKey: vi.fn(() => "gptsovits-test-key"),
  buildCustomCloudCacheKey: vi.fn(() => "custom-cloud-test-key"),
  buildMimoCacheKey: vi.fn(() => "mimo-test-key"),
  buildMosslandCacheKey: vi.fn(() => "mossland-test-key"),
  getTtsCachePath: vi.fn((cacheKey: string, format: string) =>
    path.join(os.tmpdir(), "cyrene-tts-session-test", `${cacheKey}.${format}`),
  ),
  readTtsCacheByKey: vi.fn(),
}));

vi.mock("../../tts/mossland-engine", () => ({
  synthesize: vi.fn(),
}));

const loadGeneralSettingsMock = vi.mocked(loadGeneralSettings);
const getSessionMock = vi.mocked(chatsStore.getSession);
const readTtsCacheByKeyMock = vi.mocked(ttsCache.readTtsCacheByKey);
const mosslandSynthesizeMock = vi.mocked(mosslandSynthesize);

function settings(overrides: Partial<GeneralSettings>): GeneralSettings {
  return {
    ttsEngine: "mossland",
    ttsSpeed: 1,
    ttsVolume: 1,
    ttsMinimaxKey: "",
    ttsMinimaxVoiceId: "",
    ttsMinimaxModel: "speech-2.8-turbo",
    ttsGptsovitsBaseUrl: "",
    ttsGptsovitsRefAudioPath: "",
    ttsGptsovitsPromptText: "",
    ttsGptsovitsTimeoutMs: 60_000,
    ttsCustomCloudEndpointUrl: "",
    ttsCustomCloudApiKey: "",
    ttsCustomCloudVoiceId: "",
    ttsCustomCloudTimeoutMs: 60_000,
    ttsMimoKey: "",
    ttsMimoVoiceAudioPath: "",
    ttsMimoStylePrompt: "",
    ttsMosslandKey: "moss-key",
    ttsMosslandVoiceId: "moss-voice",
    ttsMosslandModel: "moss-tts",
    ttsMosslandFormat: "mp3",
    ...overrides,
  } as GeneralSettings;
}

function sessionRequest(overrides: Partial<StartTtsRequest> = {}): StartTtsRequest {
  return {
    requestId: "r1",
    conversationId: "c1",
    messageId: "m1",
    speechText: "你好",
    converterVersion: "markdown-v1",
    ...overrides,
  };
}

describe("TTS session historical-message cache", () => {
  beforeEach(() => {
    loadGeneralSettingsMock.mockReset();
    getSessionMock.mockReset();
    readTtsCacheByKeyMock.mockReset();
    mosslandSynthesizeMock.mockReset();
  });

  it("returns the historical message cache when bypassMessageCache is unset", async () => {
    loadGeneralSettingsMock.mockReturnValue(settings({}));
    getSessionMock.mockReturnValue({
      messages: [{ id: "m1", role: "model", ttsCacheKey: "mossland-cached-key", ttsCacheVersion: "markdown-v1" }],
    } as never);
    readTtsCacheByKeyMock.mockReturnValue({ audio: Buffer.from("cached-audio"), format: "mp3" });

    const service = createTtsSynthesisService();
    const result = await service.synthesizeSession(
      sessionRequest(),
      new AbortController().signal,
      vi.fn(),
    );

    expect(result).toMatchObject({ status: "ready", cached: true, cacheKey: "mossland-cached-key" });
    expect(mosslandSynthesizeMock).not.toHaveBeenCalled();
  });

  it("skips the historical message cache and re-synthesizes when bypassMessageCache is set", async () => {
    loadGeneralSettingsMock.mockReturnValue(settings({}));
    // 消息上仍存在整段历史缓存，但段请求显式要求跳过
    getSessionMock.mockReturnValue({
      messages: [{ id: "m1", role: "model", ttsCacheKey: "mossland-cached-key", ttsCacheVersion: "markdown-v1" }],
    } as never);
    readTtsCacheByKeyMock.mockReturnValue({ audio: Buffer.from("cached-audio"), format: "mp3" });
    mosslandSynthesizeMock.mockResolvedValue({ audio: Buffer.from("fresh-audio"), format: "mp3" });

    const service = createTtsSynthesisService();
    const result = await service.synthesizeSession(
      sessionRequest({ bypassMessageCache: true }),
      new AbortController().signal,
      vi.fn(),
    );

    expect(result).toMatchObject({ status: "ready", cached: false });
    expect(mosslandSynthesizeMock).toHaveBeenCalledTimes(1);
  });

  it("synthesizes fresh audio when no historical cache exists", async () => {
    loadGeneralSettingsMock.mockReturnValue(settings({}));
    getSessionMock.mockReturnValue(null);
    mosslandSynthesizeMock.mockResolvedValue({ audio: Buffer.from("fresh-audio"), format: "mp3" });

    const service = createTtsSynthesisService();
    const result = await service.synthesizeSession(
      sessionRequest(),
      new AbortController().signal,
      vi.fn(),
    );

    expect(result).toMatchObject({ status: "ready", cached: false });
    expect(mosslandSynthesizeMock).toHaveBeenCalledTimes(1);
  });
});
