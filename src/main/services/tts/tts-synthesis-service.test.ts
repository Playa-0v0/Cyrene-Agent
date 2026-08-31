import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "../../settings/general-settings";
import { synthesizeByEngine } from "../../tts/tts-dispatcher";
import { createTtsSynthesisService } from "./tts-synthesis-service";

vi.mock("../../tts/tts-dispatcher", () => ({
  synthesizeByEngine: vi.fn(),
}));

const synthesizeByEngineMock = vi.mocked(synthesizeByEngine);

function settings(overrides: Partial<GeneralSettings>): GeneralSettings {
  return {
    ttsEngine: "off",
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
    ttsMosslandKey: "",
    ttsMosslandVoiceId: "",
    ttsMosslandModel: "moss-tts",
    ttsMosslandFormat: "mp3",
    ...overrides,
  } as GeneralSettings;
}

describe("channel TTS synthesis", () => {
  beforeEach(() => {
    synthesizeByEngineMock.mockReset();
  });

  it("returns Opus audio for Feishu after channel conversion", async () => {
    synthesizeByEngineMock.mockResolvedValue({
      audio: Buffer.from("ID3-source"),
      format: "mp3",
    });
    const service = createTtsSynthesisService({
      convertFeishuAudio: async () => Buffer.from("OggS-converted"),
    });

    const result = await service.synthesizeChannelTts("你好", settings({
      ttsEngine: "minimax",
      ttsMinimaxKey: "minimax-key",
      ttsMinimaxVoiceId: "voice-1",
    }), "feishu");

    expect(result).toEqual({
      audio: Buffer.from("OggS-converted"),
      format: "opus",
      mime: "audio/ogg",
      extension: ".opus",
    });
  });

  it("uses Mossland credentials, model, and format for channel synthesis", async () => {
    synthesizeByEngineMock.mockResolvedValue({
      audio: Buffer.from("ID3-mossland"),
      format: "mp3",
    });
    const service = createTtsSynthesisService({
      convertFeishuAudio: async (audio: Buffer) => audio,
    });

    await service.synthesizeChannelTts("晚安", settings({
      ttsEngine: "mossland",
      ttsMosslandKey: "moss-key",
      ttsMosslandVoiceId: "moss-voice",
      ttsMosslandModel: "moss-model",
      ttsMosslandFormat: "wav",
    }), "feishu");

    expect(synthesizeByEngineMock).toHaveBeenCalledWith(
      "mossland",
      expect.objectContaining({
        apiKey: "moss-key",
        voiceId: "moss-voice",
        model: "moss-model",
        mosslandFormat: "wav",
      }),
    );
  });
});
