// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const html = fs.readFileSync(path.join(process.cwd(), "src/renderer/settings/index.html"), "utf8");

describe("ASR settings panel", () => {
  beforeEach(() => {
    vi.resetModules();
    const panel = html.match(/<section[^>]+id="asr-panel"[\s\S]*?<\/section>/)?.[0];
    if (!panel) throw new Error("ASR panel markup is missing");
    document.body.innerHTML = panel;
  });

  it("loads the shared Mossland API key and only shows its provider fields", async () => {
    Object.defineProperty(window, "tts", {
      configurable: true,
      value: {
        loadSettings: vi.fn(async () => ({
          asrEngine: "mossland",
          ttsMosslandKey: "shared-moss-key",
        })),
        saveSettings: vi.fn(async () => undefined),
      },
    });

    const { loadAsrConfig } = await import("./panel");
    await loadAsrConfig();

    expect((document.getElementById("asr-engine") as HTMLSelectElement).value).toBe("mossland");
    expect((document.getElementById("asr-mossland-key") as HTMLInputElement).value).toBe("shared-moss-key");
    expect((document.getElementById("asr-mossland-config") as HTMLElement).style.display).toBe("block");
    expect((document.getElementById("asr-aliyun-config") as HTMLElement).style.display).toBe("none");
  });
});
