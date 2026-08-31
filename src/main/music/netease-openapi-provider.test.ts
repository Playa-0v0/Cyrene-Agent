import { describe, it, expect, vi } from "vitest";
import { NeteaseOpenapiProvider } from "./netease-openapi-provider";
import type { NeteaseOpenapiClient } from "./netease-openapi-client";
import type { PlaybackDispatchResult } from "./types";

const ENC = "4C777A98B81DF0CC069B59F63F3882B1";
const ENC2 = "B".repeat(32);

function makeClient() {
  return {
    getDailyRecommendations: vi.fn(),
    searchSongs: vi.fn(),
    getSongDetail: vi.fn(),
    getCreatedPlaylists: vi.fn(),
    getPlaylistDetail: vi.fn(),
    getPlaylistSongs: vi.fn(),
    createPlaylist: vi.fn(),
    addSongsToPlaylist: vi.fn(),
    removeSongsFromPlaylist: vi.fn(),
    getSubscribedAlbums: vi.fn(),
  };
}

const songRec = { originalId: 1, id: ENC, name: "晴天", artists: [{ name: "周杰伦" }], duration: 182890 };

describe("NeteaseOpenapiProvider", () => {
  it("searchTracks trims keyword and normalizes records", async () => {
    const c = makeClient();
    c.searchSongs.mockResolvedValue({ recordCount: 1, records: [songRec, { ...songRec, id: ENC2, visible: false }] });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);
    const tracks = await p.searchTracks("  晴天  ");
    expect(c.searchSongs).toHaveBeenCalledWith("晴天", 30, 0);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: ENC, encryptedId: ENC, originalId: 1 });
  });

  it("searchTracks rejects empty keyword", async () => {
    const p = new NeteaseOpenapiProvider(makeClient() as unknown as NeteaseOpenapiClient);
    await expect(p.searchTracks("   ")).rejects.toThrow(/E_SEARCH_KEYWORD_EMPTY/);
  });

  it("getDailyRecommendations normalizes the bare array", async () => {
    const c = makeClient();
    c.getDailyRecommendations.mockResolvedValue([songRec]);
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);
    expect(await p.getDailyRecommendations()).toHaveLength(1);
  });

  it("playTrack: without dispatcher → client_unavailable (URL still resolved)", async () => {
    const c = makeClient();
    c.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: "http://x/y.mp3" });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);
    const r = await p.playTrack(ENC);
    expect(r).toEqual({
      state: "client_unavailable",
      resourceType: "song",
      resourceId: ENC,
      errorCode: "E_PLAYBACK_DISPATCHER_MISSING",
    });
  });

  it("playTrack: dispatches resolved URL; no playUrl → E_TRACK_NOT_PLAYABLE; bad id → E_INVALID_ENCRYPTED_ID", async () => {
    const c = makeClient();
    c.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: "http://x/y.mp3", artistName: "周杰伦" });
    const dispatch = vi.fn().mockResolvedValue({ state: "dispatched", resourceType: "song", resourceId: ENC });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient, dispatch);
    await p.playTrack(ENC);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: "song", playUrl: "http://x/y.mp3" }));

    c.getSongDetail.mockResolvedValue({ name: "受限", playUrl: "" });
    await expect(p.playTrack(ENC)).rejects.toThrow(/E_TRACK_NOT_PLAYABLE/);

    await expect(p.playTrack("123")).rejects.toThrow(/E_INVALID_ENCRYPTED_ID/);
  });

  it("playPlaylist: skips unplayable first tracks, dispatches with full track list", async () => {
    const c = makeClient();
    c.getPlaylistSongs.mockResolvedValue([
      { ...songRec, id: ENC, visible: false },
      { ...songRec, id: ENC2, name: "second" },
    ]);
    c.getSongDetail.mockResolvedValue({ name: "second", playUrl: "http://x/2.mp3" });
    const dispatch = vi.fn().mockResolvedValue({ state: "dispatched", resourceType: "playlist", resourceId: "pl" });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient, dispatch);
    const r = await p.playPlaylist("pl");
    expect(r.state).toBe("dispatched");
    expect(c.getSongDetail).toHaveBeenCalledTimes(1);
    expect(c.getSongDetail).toHaveBeenCalledWith(ENC2);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "playlist", tracks: [expect.objectContaining({ id: ENC2 })] }),
    );
  });

  it("playPlaylist: empty playlist → E_PLAYLIST_EMPTY", async () => {
    const c = makeClient();
    c.getPlaylistSongs.mockResolvedValue([]);
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);
    await expect(p.playPlaylist("pl")).rejects.toThrow(/E_PLAYLIST_EMPTY/);
  });

  it("getMyPlaylists / getPlaylistDetail / createPlaylist / addToPlaylist", async () => {
    const c = makeClient();
    c.getCreatedPlaylists.mockResolvedValue({ records: [{ id: "P".repeat(32), name: "list", trackCount: 3 }] });
    c.getPlaylistDetail.mockResolvedValue({ id: "P".repeat(32), name: "list", describe: "d" });
    c.getPlaylistSongs.mockResolvedValue([songRec]);
    c.createPlaylist.mockResolvedValue({ id: "Q".repeat(32), name: "new" });
    c.addSongsToPlaylist.mockResolvedValue({ count: 1 });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);

    expect((await p.getMyPlaylists())[0].trackCount).toBe(3);
    const detail = await p.getPlaylistDetail("P".repeat(32));
    expect(detail).toMatchObject({ name: "list", description: "d" });
    expect(detail.tracks[0].encryptedId).toBe(ENC);

    const created = await p.createPlaylist(" new ");
    expect(c.createPlaylist).toHaveBeenCalledWith("new");
    expect(created.id).toBe("Q".repeat(32));

    const added = await p.addToPlaylist("P".repeat(32), [ENC]);
    expect(added).toEqual({ added: 1, playlistId: "P".repeat(32) });
    await expect(p.addToPlaylist("P".repeat(32), [])).rejects.toThrow(/E_ADD_TO_PLAYLIST_EMPTY/);
    await expect(p.addToPlaylist("P".repeat(32), ["not-hex"])).rejects.toThrow(/E_INVALID_ENCRYPTED_ID/);
  });

  it("removeFromPlaylist: normalizes count, validates ids", async () => {
    const c = makeClient();
    c.removeSongsFromPlaylist.mockResolvedValue({ count: 1 });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);

    const removed = await p.removeFromPlaylist("P".repeat(32), [ENC, ENC2]);
    expect(c.removeSongsFromPlaylist).toHaveBeenCalledWith("P".repeat(32), [ENC, ENC2]);
    expect(removed).toEqual({ removed: 1, playlistId: "P".repeat(32) });

    // 无 count 字段 → 回退为请求数
    c.removeSongsFromPlaylist.mockResolvedValue({ whatever: true });
    const fallback = await p.removeFromPlaylist("P".repeat(32), [ENC, ENC2]);
    expect(fallback.removed).toBe(2);

    await expect(p.removeFromPlaylist("P".repeat(32), [])).rejects.toThrow(/E_REMOVE_FROM_PLAYLIST_EMPTY/);
    await expect(p.removeFromPlaylist("P".repeat(32), ["not-hex"])).rejects.toThrow(/E_INVALID_ENCRYPTED_ID/);
  });

  it("getMySubscriptions: artists → [] (no endpoint), albums → normalized", async () => {
    const c = makeClient();
    c.getSubscribedAlbums.mockResolvedValue({ records: [{ id: "A".repeat(32), name: "叶惠美" }] });
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient);
    expect(await p.getMySubscriptions("artists")).toEqual([]);
    expect((await p.getMySubscriptions("albums"))[0].name).toBe("叶惠美");
  });

  it("passes dispatcher failures through", async () => {
    const c = makeClient();
    c.getSongDetail.mockResolvedValue({ name: "x", playUrl: "http://x/y.mp3" });
    const dispatch = vi.fn().mockResolvedValue({ state: "launch_failed", resourceType: "song", resourceId: ENC } as PlaybackDispatchResult);
    const p = new NeteaseOpenapiProvider(c as unknown as NeteaseOpenapiClient, dispatch);
    expect((await p.playTrack(ENC)).state).toBe("launch_failed");
  });
});
