// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const REQUIRED_INPUT_IDS = [
  "tts-auto-read",
  "tts-speed",
  "tts-volume",
  "tts-minimax-key",
  "tts-minimax-voice",
  "tts-streaming",
  "tts-minimax-vocal-enhance",
  "tts-gptsovits-url",
  "tts-gptsovits-ref-audio",
  "tts-gptsovits-prompt-text",
  "tts-gptsovits-timeout",
  "tts-custom-cloud-url",
  "tts-custom-cloud-key",
  "tts-custom-cloud-voice",
  "tts-custom-cloud-timeout",
  "tts-mimo-key",
  "tts-mimo-voice-audio",
  "tts-mimo-style",
  "tts-mossland-key",
  "tts-mossland-voice",
  "tts-mossland-text",
];

function addInput(id: string): void {
  const input = document.createElement("input");
  input.id = id;
  document.body.appendChild(input);
}

function addSelect(id: string, values: string[]): HTMLSelectElement {
  const select = document.createElement("select");
  select.id = id;
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  document.body.appendChild(select);
  return select;
}

describe("TTS settings panel", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
    REQUIRED_INPUT_IDS.forEach(addInput);
    addSelect("tts-minimax-model", ["speech-2.8-turbo", "speech-2.8-hd"]);
    addSelect("tts-gptsovits-format", ["wav", "mp3"]);
    addSelect("tts-custom-cloud-format", ["mp3", "wav"]);
    addSelect("tts-mossland-model", ["moss-tts-1.5-flash", "moss-tts-1.0-pro"]);
    addSelect("tts-mossland-format", ["mp3", "wav"]);
  });

  it("persists the MiniMax model immediately when the select changes", async () => {
    const saveSettings = vi.fn(async () => ({}));
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({ ttsMinimaxModel: "speech-2.8-turbo" })),
        saveSettings,
      },
    });
    await import("./panel");
    await Promise.resolve();
    saveSettings.mockClear();

    const select = document.getElementById("tts-minimax-model") as HTMLSelectElement;
    select.value = "speech-2.8-hd";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();

    expect(saveSettings).toHaveBeenCalledWith({ ttsMinimaxModel: "speech-2.8-hd" });
  });

  it("restores the saved Mossland model instead of forcing the legacy model", async () => {
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({ ttsMosslandModel: "moss-tts-1.0-pro" })),
        saveSettings: vi.fn(async () => ({})),
      },
    });

    await import("./panel");
    await Promise.resolve();

    expect((document.getElementById("tts-mossland-model") as HTMLSelectElement).value)
      .toBe("moss-tts-1.0-pro");
  });
});
