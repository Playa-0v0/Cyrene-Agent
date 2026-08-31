import { describe, it, expect, beforeEach } from "vitest";
import { SelectionSetCache } from "./selection-set-cache";
import type { MusicSelectionSet, MusicTrack } from "./types";

function track(id: string): MusicTrack {
  return { id, name: `n${id}`, artists: ["a"] };
}
function set(id: string, conv: string, n = 3, ageMs = 0): MusicSelectionSet {
  return {
    setId: id,
    provider: "netease-cloud-music",
    source: "search",
    query: "q",
    createdAt: Date.now() - ageMs,
    expiresAt: Date.now() + 30 * 60_000 - ageMs,
    conversationId: conv,
    tracks: Array.from({ length: n }, (_, i) => track(`${id}-${i}`)),
  };
}

describe("SelectionSetCache", () => {
  let c: SelectionSetCache;
  beforeEach(() => {
    c = new SelectionSetCache();
  });

  it("adds and retrieves a set in same conversation", () => {
    const s = set("s1", "convA");
    c.add(s);
    expect(c.get("s1", "convA")).toEqual(s);
  });

  it("returns null for cross-conversation access", () => {
    const s = set("s1", "convA");
    c.add(s);
    expect(c.get("s1", "convB")).toBeNull();
  });

  it("returns null for unknown setId", () => {
    expect(c.get("missing", "convA")).toBeNull();
  });

  it("evicts after TTL", () => {
    const s = set("s1", "convA", 3, 31 * 60_000);
    c.add(s);
    expect(c.get("s1", "convA")).toBeNull();
  });

  it("evicts LRU when per-conversation limit exceeded", () => {
    for (let i = 0; i < 21; i++) c.add(set(`s${i}`, "convA"));
    expect(c.get("s0", "convA")).toBeNull();
    expect(c.get("s20", "convA")).not.toBeNull();
  });

  it("rejects sets with more than 30 tracks", () => {
    const big = set("big", "convA", 31);
    expect(() => c.add(big)).toThrow(/too many tracks/i);
  });

  it("returns the newest non-expired set for a conversation and source", () => {
    const search = set("search-1", "convA");
    const daily = { ...set("daily-1", "convA"), source: "daily_recommendation" as const };
    c.add(search);
    c.add(daily);

    expect(c.latest("convA", "daily_recommendation")).toEqual(daily);
    expect(c.latest("convB", "daily_recommendation")).toBeNull();
  });
});
