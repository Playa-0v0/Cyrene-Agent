import { describe, expect, it } from "vitest";
import { DEFAULT_CITA_SETTINGS, normalizeCitaSettings } from "./settings";

describe("normalizeCitaSettings", () => {
  it("defaults to disabled remote mode", () => {
    expect(normalizeCitaSettings(undefined)).toEqual(DEFAULT_CITA_SETTINGS);
    expect(DEFAULT_CITA_SETTINGS).toEqual({ enabled: false, semanticEngine: "remote" });
  });

  it("preserves the switch but refuses the deferred local engine", () => {
    expect(normalizeCitaSettings({ enabled: true, semanticEngine: "local" })).toEqual({
      enabled: true,
      semanticEngine: "remote",
    });
  });
});
