import { describe, expect, it } from "vitest";
import { normalizeMusicCardData } from "./music-card";

describe("normalizeMusicCardData", () => {
  it("preserves the real displayed order and rejects malformed tracks", () => {
    const card = normalizeMusicCardData({
      setId: "set-1",
      source: "daily_recommendation",
      tracks: [
        { id: "102", name: "夜曲", artists: ["周杰伦"] },
        { id: "", name: "invalid", artists: [] },
        { id: "101", name: "晴天", artists: ["周杰伦"] },
      ],
    });

    expect(card?.tracks.map((track) => track.id)).toEqual(["102", "101"]);
  });

  it("caps cards at five tracks", () => {
    const card = normalizeMusicCardData({
      setId: "set-1",
      source: "search",
      tracks: Array.from({ length: 8 }, (_, index) => ({ id: String(index + 1), name: `S${index}`, artists: ["A"] })),
    });

    expect(card?.tracks).toHaveLength(5);
  });
});
