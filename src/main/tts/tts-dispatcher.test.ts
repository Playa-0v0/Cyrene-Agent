import { describe, expect, it, vi } from "vitest";

vi.mock("./custom-cloud-engine", () => ({
  synthesize: vi.fn(async () => ({ audio: Buffer.from("ID3ok"), format: "mp3" })),
}));
vi.mock("./mimo-engine", () => ({
  synthesize: vi.fn(async () => ({ audio: Buffer.from("RIFFmimo"), format: "wav" })),
}));

import { synthesize as customSynthesize } from "./custom-cloud-engine";
import { synthesize as mimoSynthesize } from "./mimo-engine";
import { synthesizeByEngine } from "./tts-dispatcher";

describe("tts-dispatcher custom-cloud", () => {
  it("routes custom-cloud payload to the custom cloud engine", async () => {
    const result = await synthesizeByEngine("custom-cloud", {
      text: "hello",
      endpointUrl: "https://tts.example.com",
      apiKey: "k",
      voiceId: "cyrene-voice",
      format: "mp3",
    });

    expect(result.format).toBe("mp3");
    expect(result.audio.toString()).toBe("ID3ok");
    expect(customSynthesize).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl: "https://tts.example.com",
      apiKey: "k",
      voiceId: "cyrene-voice",
      text: "hello",
    }));
  });
});

describe("tts-dispatcher mimo", () => {
  it("routes mimo payload to the Xiaomi MiMo engine", async () => {
    const result = await synthesizeByEngine("mimo", {
      text: "hello",
      apiKey: "k",
      voiceAudioPath: "C:\\voices\\cyrene.mp3",
      promptText: "溫柔一點",
    });

    expect(result.format).toBe("wav");
    expect(result.audio.toString()).toBe("RIFFmimo");
    expect(mimoSynthesize).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "k",
      voiceAudioPath: "C:\\voices\\cyrene.mp3",
      text: "hello",
      stylePrompt: "溫柔一點",
    }));
  });
});
