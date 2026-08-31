import { describe, expect, it } from "vitest";
import type { GeneralSettings } from "./general-settings";
import { normalizeGeneralSettings } from "./settings-facade";

describe("general LSP settings", () => {
  it("keeps valid user server overrides and safely drops malformed settings", () => {
    const settings = normalizeGeneralSettings({
      lspServerOverrides: [
        { id: "python-pyright", command: "basedpyright-langserver", args: ["--stdio"] },
        { id: "python-pyright", command: "duplicate" },
        { id: "unknown-server", command: "not-allowed" },
        { id: "gopls", command: "  " },
        { id: "typescript-language-server", initializationOptions: { preferences: { includeCompletionsForModuleExports: true } }, constructor: "unsafe" },
      ] as unknown as GeneralSettings["lspServerOverrides"],
    });

    expect(settings.lspServerOverrides).toEqual([
      { id: "python-pyright", command: "basedpyright-langserver", args: ["--stdio"] },
      { id: "typescript-language-server", initializationOptions: { preferences: { includeCompletionsForModuleExports: true } } },
    ]);
  });

  it("loads older settings without requiring an LSP migration", () => {
    expect(normalizeGeneralSettings({}).lspServerOverrides).toEqual([]);
  });
});

describe("general Harness tool concurrency settings", () => {
  it("defaults to four and normalizes the configured safe range", () => {
    expect(normalizeGeneralSettings({}).maxParallelToolCalls).toBe(4);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: 0 } as never).maxParallelToolCalls).toBe(1);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: 99 } as never).maxParallelToolCalls).toBe(8);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: 3.8 } as never).maxParallelToolCalls).toBe(3);
    expect(normalizeGeneralSettings({ maxParallelToolCalls: "invalid" } as never).maxParallelToolCalls).toBe(4);
  });
});

describe("general ASR settings", () => {
  it("keeps Mossland as a supported ASR provider", () => {
    const settings = normalizeGeneralSettings({ asrEngine: "mossland" } as never);

    expect(settings.asrEngine).toBe("mossland");
  });
});

describe("general Mossland TTS settings", () => {
  it("uses the current flash model by default", () => {
    expect(normalizeGeneralSettings({}).ttsMosslandModel).toBe("moss-tts-1.5-flash");
  });

  it("migrates the legacy model and synchronous pcm format", () => {
    const settings = normalizeGeneralSettings({
      ttsMosslandModel: "moss-tts",
      ttsMosslandFormat: "pcm",
    } as never);

    expect(settings.ttsMosslandModel).toBe("moss-tts-1.5-flash");
    expect(settings.ttsMosslandFormat).toBe("mp3");
  });

  it("keeps both documented synchronous models", () => {
    expect(normalizeGeneralSettings({ ttsMosslandModel: "moss-tts-1.5-flash" } as never).ttsMosslandModel)
      .toBe("moss-tts-1.5-flash");
    expect(normalizeGeneralSettings({ ttsMosslandModel: "moss-tts-1.0-pro" } as never).ttsMosslandModel)
      .toBe("moss-tts-1.0-pro");
  });

  it("defaults an empty Mossland model and trims a saved snapshot id", () => {
    expect(normalizeGeneralSettings({ ttsMosslandModel: "   " } as never).ttsMosslandModel)
      .toBe("moss-tts-1.5-flash");
    expect(normalizeGeneralSettings({ ttsMosslandModel: "  moss-tts-1.5-flash-20260828  " } as never).ttsMosslandModel)
      .toBe("moss-tts-1.5-flash-20260828");
  });
});
