import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMusicCompanionHost,
  configureMusicCompanionHost,
  isMusicCompanionAvailable,
} from "./music-companion-host";

function runtimeDouble() {
  return {
    shouldInject: vi.fn(() => true),
  };
}

beforeEach(() => clearMusicCompanionHost());

describe("music-companion host", () => {
  it("uses the compound runtime as the Skill availability gate", () => {
    const runtime = runtimeDouble();
    const capabilities = { skillEnabled: true, backendAvailable: true, enabledTools: ["music_search"] };
    configureMusicCompanionHost(runtime, () => capabilities);

    expect(isMusicCompanionAvailable()).toBe(true);
    expect(runtime.shouldInject).toHaveBeenCalledWith(capabilities);
  });
  it("does not expose selection parsing when capabilities are unavailable", () => {
    const runtime = runtimeDouble();
    runtime.shouldInject.mockReturnValue(false);
    configureMusicCompanionHost(runtime, () => ({ skillEnabled: true, backendAvailable: false, enabledTools: [] }));

    expect(isMusicCompanionAvailable()).toBe(false);
  });
});
