import { describe, it, expect } from "vitest";
import {
  normalizeSongRecord,
  normalizeSongRecords,
  normalizeSongDetail,
  normalizePlaylistRecord,
  normalizePlaylistRecords,
  normalizePlaylistDetail,
  normalizeUserProfile,
  normalizeSubscribedAlbums,
  normalizeAddToPlaylistResult,
  normalizeRemoveFromPlaylistResult,
  assertEncryptedId,
} from "./openapi-result-normalizer";
import { MusicInputError } from "./types";

const ENC = "4C777A98B81DF0CC069B59F63F3882B1";

const songRecord = {
  originalId: 3339230677,
  id: ENC,
  name: "晴天",
  duration: 182890,
  artists: [{ originalId: 6452, id: "A".repeat(32), name: "周杰伦" }],
  albumName: "叶惠美",
  coverImgUrl: "https://p1.music.126.net/x.jpg",
};

describe("normalizeSongRecord", () => {
  it("maps dual ids and fields", () => {
    expect(normalizeSongRecord(songRecord)).toEqual({
      id: ENC,
      encryptedId: ENC,
      originalId: 3339230677,
      name: "晴天",
      artists: ["周杰伦"],
      album: "叶惠美",
      durationMs: 182890,
      coverUrl: "https://p1.music.126.net/x.jpg",
    });
  });
  it("filters visible:false (unplayable)", () => {
    expect(normalizeSongRecord({ ...songRecord, visible: false })).toBeNull();
  });
  it("drops records without encrypted id", () => {
    expect(normalizeSongRecord({ ...songRecord, id: "" })).toBeNull();
    expect(normalizeSongRecord(null as never)).toBeNull();
  });
});

describe("normalizeSongRecords", () => {
  it("caps at max and skips unplayable", () => {
    const recs = [
      songRecord,
      { ...songRecord, visible: false },
      { ...songRecord, id: "B".repeat(32), name: "second" },
    ];
    const out = normalizeSongRecords(recs);
    expect(out.map((t) => t.name)).toEqual(["晴天", "second"]);
    expect(normalizeSongRecords(undefined)).toEqual([]);
    expect(normalizeSongRecords(recs, 1).length).toBe(1);
  });
});

describe("normalizeSongDetail", () => {
  it("builds a track from the detail endpoint", () => {
    const t = normalizeSongDetail(ENC, {
      name: "晴天",
      artistName: "周杰伦",
      albumName: "叶惠美",
      duration: 182890,
      coverImgUrl: "https://p1.music.126.net/x.jpg",
    });
    expect(t.id).toBe(ENC);
    expect(t.encryptedId).toBe(ENC);
    expect(t.artists).toEqual(["周杰伦"]);
  });
});

describe("normalizePlaylistRecord(s)", () => {
  it("maps fields, skips missing ids", () => {
    const pl = { id: "P".repeat(32), originalId: 123, name: "cyrene管理歌单", trackCount: 20, creatorNickName: "u", coverImgUrl: "https://p1.music.126.net/p.jpg" };
    expect(normalizePlaylistRecord(pl)).toEqual({
      id: "P".repeat(32),
      originalId: 123,
      name: "cyrene管理歌单",
      coverUrl: "https://p1.music.126.net/p.jpg",
      trackCount: 20,
      creator: "u",
    });
    expect(normalizePlaylistRecords([{ ...pl, id: "" }, pl])).toHaveLength(1);
  });
});

describe("normalizePlaylistDetail", () => {
  it("merges detail + tracks", () => {
    const d = normalizePlaylistDetail(
      { id: "P".repeat(32), name: "list", describe: "desc", trackCount: 2 },
      [songRecord, { ...songRecord, visible: false }],
    );
    expect(d.name).toBe("list");
    expect(d.description).toBe("desc");
    expect(d.tracks).toHaveLength(1);
    expect(d.tracks[0].encryptedId).toBe(ENC);
  });
});

describe("normalizeUserProfile", () => {
  it("requires nickname", () => {
    expect(normalizeUserProfile({ nickname: "Playa0", userId: 1, avatarUrl: "a" })).toEqual({
      userId: "1",
      nickname: "Playa0",
      avatarUrl: "a",
    });
    expect(normalizeUserProfile({ userId: 1 })).toBeNull();
  });
});

describe("normalizeSubscribedAlbums", () => {
  it("accepts records wrapper and bare array, tolerates unknown shapes", () => {
    const recs = [{ id: "A".repeat(32), name: "叶惠美", coverImgUrl: "c" }, { id: "B".repeat(32), albumName: "范特西" }, { name: "no-id" }];
    expect(normalizeSubscribedAlbums({ records: recs })).toEqual([
      { id: "A".repeat(32), name: "叶惠美", coverUrl: "c" },
      { id: "B".repeat(32), name: "范特西", coverUrl: undefined },
    ]);
    expect(normalizeSubscribedAlbums(recs)).toHaveLength(2);
    expect(normalizeSubscribedAlbums({ weird: true })).toEqual([]);
  });
});

describe("normalizeAddToPlaylistResult", () => {
  it("prefers server count, falls back to requested", () => {
    expect(normalizeAddToPlaylistResult({ count: 2 }, 3, "pl")).toEqual({ added: 2, playlistId: "pl" });
    expect(normalizeAddToPlaylistResult({ whatever: 1 }, 3, "pl")).toEqual({ added: 3, playlistId: "pl" });
  });
});

describe("normalizeRemoveFromPlaylistResult", () => {
  it("prefers server count, falls back to requested", () => {
    expect(normalizeRemoveFromPlaylistResult({ removedCount: 2 }, 3, "pl")).toEqual({ removed: 2, playlistId: "pl" });
    expect(normalizeRemoveFromPlaylistResult({ whatever: 1 }, 3, "pl")).toEqual({ removed: 3, playlistId: "pl" });
  });
});

describe("assertEncryptedId", () => {
  it("accepts 32-hex, rejects the rest", () => {
    expect(assertEncryptedId(ENC)).toBe(ENC);
    expect(() => assertEncryptedId("3339230677")).toThrow(MusicInputError);
    expect(() => assertEncryptedId("zz")).toThrow(/E_INVALID_ENCRYPTED_ID/);
    expect(() => assertEncryptedId(ENC.slice(0, 31))).toThrow(MusicInputError);
  });
});
