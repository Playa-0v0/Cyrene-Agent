import { describe, expect, it, vi } from "vitest";
import { MusicRouter } from "./music-router";
import type { MusicProvider } from "./music-provider";

function provider(id: string): MusicProvider {
  return {
    id,
    getDailyRecommendations: vi.fn(),
    searchTracks: vi.fn(),
    playTrack: vi.fn(),
    playPlaylist: vi.fn(),
  };
}

describe("MusicRouter", () => {
  it("uses the configured default provider when none is explicit", () => {
    const netease = provider("netease-cloud-music");
    const qq = provider("qq-music");
    const router = new MusicRouter(new Map([[netease.id, netease], [qq.id, qq]]), () => "qq-music");

    expect(router.resolve()).toBe(qq);
    expect(router.resolve("netease-cloud-music")).toBe(netease);
  });

  it("fails closed when the selected provider is unavailable", () => {
    const router = new MusicRouter(new Map(), () => "missing");
    expect(() => router.resolve()).toThrow(/E_MUSIC_PROVIDER_UNAVAILABLE:missing/);
  });
});
