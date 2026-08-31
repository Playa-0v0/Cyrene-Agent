import { describe, expect, it } from "vitest";
import { getCitaUiState } from "./cita-settings-state";

describe("getCitaUiState", () => {
  it("always exposes local cognition as disabled", () => {
    expect(getCitaUiState({ enabled: true, semanticEngine: "remote" })).toEqual({
      enabled: true,
      selectedEngine: "remote",
      localDisabled: true,
    });
  });

  it("normalizes stale local settings back to remote", () => {
    expect(getCitaUiState({ enabled: false, semanticEngine: "local" }).selectedEngine).toBe("remote");
  });
});
