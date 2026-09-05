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
  "tts-early-read-split-enabled",
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

function addOptionGroup(id: string, values: string[]): HTMLElement {
  const group = document.createElement("div");
  group.id = id;
  group.className = "option-blocks";
  group.setAttribute("role", "radiogroup");
  for (const value of values) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-block";
    button.dataset.value = value;
    button.textContent = value;
    button.setAttribute("aria-pressed", "false");
    group.appendChild(button);
  }
  document.body.appendChild(group);
  return group;
}

function splitModeButtons(): HTMLButtonElement[] {
  const group = document.getElementById("tts-early-read-split-mode");
  if (!group) return [];
  return Array.from(group.querySelectorAll<HTMLButtonElement>(".option-block"));
}

describe("TTS settings panel", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
    REQUIRED_INPUT_IDS.forEach(addInput);
    addSelect("tts-minimax-model", ["speech-2.8-turbo", "speech-2.8-hd"]);
    addOptionGroup("tts-early-read-split-mode", ["sentence", "paragraph"]);
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

  it("persists the early-read split mode when the paragraph button is clicked", async () => {
    const saveSettings = vi.fn(async () => ({}));
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({ ttsEarlyReadSplitMode: "sentence" })),
        saveSettings,
      },
    });
    await import("./panel");
    await Promise.resolve();
    saveSettings.mockClear();

    const paragraph = splitModeButtons().find((button) => button.dataset.value === "paragraph");
    expect(paragraph).toBeDefined();
    paragraph!.click();
    await Promise.resolve();

    expect(saveSettings).toHaveBeenCalledWith({ ttsEarlyReadSplitMode: "paragraph" });
    expect(paragraph!.classList.contains("is-active")).toBe(true);
    expect(paragraph!.getAttribute("aria-pressed")).toBe("true");
    expect(splitModeButtons().find((button) => button.dataset.value === "sentence")!.classList.contains("is-active")).toBe(false);
  });

  it("restores the early-read split switch and disables buttons when saved off", async () => {
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({
          ttsEarlyReadSplitEnabled: false,
          ttsEarlyReadSplitMode: "paragraph",
        })),
        saveSettings: vi.fn(async () => ({})),
      },
    });

    await import("./panel");
    await Promise.resolve();

    const toggle = document.getElementById("tts-early-read-split-enabled") as HTMLInputElement;
    const buttons = splitModeButtons();
    expect(toggle.checked).toBe(false);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    const paragraph = buttons.find((button) => button.dataset.value === "paragraph")!;
    expect(paragraph.classList.contains("is-active")).toBe(true);
    expect(paragraph.getAttribute("aria-pressed")).toBe("true");
  });

  it("persists the early-read split switch when toggled off and disables buttons", async () => {
    const saveSettings = vi.fn(async () => ({}));
    Object.assign(window, {
      tts: {
        loadSettings: vi.fn(async () => ({ ttsEarlyReadSplitEnabled: true })),
        saveSettings,
      },
    });
    await import("./panel");
    await Promise.resolve();
    saveSettings.mockClear();

    const toggle = document.getElementById("tts-early-read-split-enabled") as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();

    expect(splitModeButtons().every((button) => button.disabled)).toBe(true);
    expect(saveSettings).toHaveBeenCalledWith({ ttsEarlyReadSplitEnabled: false });
  });
});
