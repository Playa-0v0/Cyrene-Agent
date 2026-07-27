import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));
vi.mock("./inbound-server", () => ({ registerLocalGetRoute: vi.fn() }));
vi.mock("./settings-store", () => ({
  loadChannelsSettings: () => ({
    spotify: { enabled: true, clientId: "client", clientSecret: "secret", refreshToken: "refresh" },
  }),
  saveChannelsSettings: vi.fn(),
}));

import { controlSpotify, disconnectSpotify, getSpotifyArtistTopTracks, getSpotifyPlaylistTracks, getSpotifyPlaylists, searchSpotifyArtists, spotifyUriFromInput } from "./spotify-control";

describe("Spotify playback control", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    disconnectSpotify();
  });

  it("converts official track, album and playlist links to Spotify URIs", () => {
    expect(spotifyUriFromInput("https://open.spotify.com/track/abc123?si=test")).toBe("spotify:track:abc123");
    expect(spotifyUriFromInput("https://open.spotify.com/album/album123")).toBe("spotify:album:album123");
    expect(spotifyUriFromInput("spotify:playlist:list123")).toBe("spotify:playlist:list123");
    expect(spotifyUriFromInput("https://example.com/track/abc123")).toBeNull();
  });

  it("searches a song name and starts the matched track on the selected device", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tracks: { items: [{ uri: "spotify:track:found" }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await controlSpotify({ command: "play", query: "Cry For Me", deviceId: "computer" });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining("/search?"), expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://api.spotify.com/v1/me/player/play?device_id=computer", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ uris: ["spotify:track:found"] }),
    }));
  });

  it("loads account playlists and converts their tracks into Discord VC sources", async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("accounts.spotify.com/api/token")) {
        return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/me/playlists")) return new Response(JSON.stringify({ items: [{
          id: "list-one",
          name: "私人歌单",
          external_urls: { spotify: "https://open.spotify.com/playlist/list-one" },
          images: [{ url: "https://example.com/list.jpg" }],
          tracks: { total: 1 },
          owner: { display_name: "主人" },
        }] }), { status: 200 });
      if (url.includes("/playlists/list-one/tracks")) return new Response(JSON.stringify({ items: [{ track: {
          id: "track-one",
          name: "勇者",
          duration_ms: 195000,
          artists: [{ name: "YOASOBI" }],
          external_urls: { spotify: "https://open.spotify.com/track/track-one" },
          album: { images: [{ url: "https://example.com/track.jpg" }] },
        } }], next: null }), { status: 200 });
      throw new Error(`Unexpected Spotify URL: ${url}`);
    });

    const playlists = await getSpotifyPlaylists();
    const tracks = await getSpotifyPlaylistTracks(playlists[0]);

    expect(playlists[0]).toMatchObject({ id: "list-one", name: "私人歌單", total: 1 });
    expect(tracks[0]).toMatchObject({
      title: "勇者 — YOASOBI",
      playbackUrl: "ytsearch1:勇者 YOASOBI",
      playlistTitle: "私人歌單",
      duration: 195,
    });
  });

  it("searches an artist and converts top tracks into Discord VC sources", async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("accounts.spotify.com/api/token")) {
        return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("/search?") && url.includes("type=artist")) return new Response(JSON.stringify({ artists: { items: [{
        id: "artistone",
        name: "测试歌手",
        external_urls: { spotify: "https://open.spotify.com/artist/artistone" },
        followers: { total: 1234 },
      }] } }), { status: 200 });
      if (url.endsWith("/artists/artistone")) return new Response(JSON.stringify({ name: "测试歌手" }), { status: 200 });
      if (url.includes("/artists/artistone/top-tracks")) return new Response(JSON.stringify({ tracks: [{
        id: "top-one",
        name: "测试歌曲",
        duration_ms: 180000,
        artists: [{ name: "测试歌手" }],
        external_urls: { spotify: "https://open.spotify.com/track/top-one" },
      }] }), { status: 200 });
      throw new Error(`Unexpected Spotify URL: ${url}`);
    });

    const artists = await searchSpotifyArtists("测试歌手");
    const tracks = await getSpotifyArtistTopTracks(artists[0].id);

    expect(artists[0]).toMatchObject({ name: "測試歌手", followers: 1234 });
    expect(tracks[0]).toMatchObject({
      title: "測試歌曲 — 測試歌手",
      playlistTitle: "測試歌手 · 熱門歌曲",
      playbackUrl: "ytsearch1:測試歌曲 測試歌手",
    });
  });
});
