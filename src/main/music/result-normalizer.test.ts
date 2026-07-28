import { describe, it, expect } from "vitest";
import { normalizeDailyRecommendations, normalizeSearchResults } from "./result-normalizer";

describe("result-normalizer", () => {
  it("normalizes daily recommendations into tracks", () => {
    const out = normalizeDailyRecommendations({ success: true, songs: [
      { id: 1, name: "Song A", artist: "X" },
      { id: 2, name: "Song B", artist: "Y" },
    ] });
    expect(out).toHaveLength(2);
    expect(out[0].artists).toEqual(["X"]);
    expect(out[1].id).toBe("2");
  });

  it("falls back to single artist when artist is array", () => {
    const out = normalizeDailyRecommendations({ success: true, songs: [{ id: 3, name: "t", artist: ["A", "B"] }] });
    expect(out[0].artists).toEqual(["A", "B"]);
  });

  it("normalizes search results with category=song", () => {
    const out = normalizeSearchResults({ success: true, items: [
      { id: 10, name: "S", artists: ["P", "Q"], album: "AL" },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0].artists).toEqual(["P", "Q"]);
    expect(out[0].album).toBe("AL");
  });

  it("normalizes upstream bare-array search results", () => {
    const out = normalizeSearchResults([
      { id: 11, name: "Bare", artist: "Solo" },
    ]);

    expect(out).toEqual([
      expect.objectContaining({ id: "11", name: "Bare", artists: ["Solo"] }),
    ]);
  });

  it("returns empty array on failure", () => {
    expect(normalizeSearchResults({ success: false, error: "x" })).toEqual([]);
  });

  it("preserves a structured daily recommendation failure", () => {
    expect(() => normalizeDailyRecommendations({
      success: false,
      songs: [],
      error: { code: "E_DAILY_RECOMMEND_FAILED", message: "upstream unavailable" },
    })).toThrow(/E_DAILY_RECOMMEND_FAILED.*upstream unavailable/);
  });

  it("rejects legacy human-readable daily recommendation text", () => {
    expect(() => normalizeDailyRecommendations("📅 今日推荐 (1首): ..."))
      .toThrow(/E_DAILY_RECOMMEND_INVALID_RESPONSE/);
  });

  it("clamps to 30 tracks max", () => {
    const songs = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `n${i}`, artist: "a" }));
    expect(normalizeDailyRecommendations({ success: true, songs })).toHaveLength(30);
  });
});
