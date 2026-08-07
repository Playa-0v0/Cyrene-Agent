import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { deleteDiscordMusicFavorite, deleteDiscordMusicFavorites, loadDiscordMusicFavorites, moveDiscordMusicFavorite, saveDiscordMusicFavorite, loadDiscordMusicPlaylists, saveDiscordMusicPlaylist, saveDiscordMusicPlaylistLink, deleteDiscordMusicPlaylist, updateDiscordMusicPlaylist, migrateDiscordSpotifyPlaylistLinks, hasMigratedDiscordSpotifyPlaylistLinks } from "./music-favorites";

const directory = path.join(os.tmpdir(), `cyrene-music-favorites-${process.pid}`);
const filePath = path.join(directory, "favorites.json");

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("Discord music favorites", () => {
  it("persists a favorite and avoids duplicate URLs", async () => {
    const track = {
      title: "勇者",
      url: "https://example.com/song",
      thumbnail: "https://example.com/cover.jpg",
      playlistTitle: "葬送的芙莉蓮",
      duration: 195,
      index: 1,
      total: 1,
    };
    expect((await saveDiscordMusicFavorite(track, filePath)).added).toBe(true);
    expect((await saveDiscordMusicFavorite(track, filePath)).added).toBe(false);
    const favorites = await loadDiscordMusicFavorites(10, filePath);
    expect(favorites).toHaveLength(1);
    expect(favorites[0]).toMatchObject({
      title: "勇者",
      url: "https://example.com/song",
      duration: 195,
    });
  });

  it("recovers after a failed write instead of poisoning later saves", async () => {
    const blocker = path.join(directory, "not-a-directory");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(blocker, "file", "utf8");
    const track = {
      title: "Recovered song",
      url: "https://example.com/recovered-song",
      index: 1,
      total: 1,
    };

    await expect(saveDiscordMusicFavorite(track, path.join(blocker, "favorites.json"))).rejects.toThrow();
    await expect(saveDiscordMusicFavorite(track, filePath)).resolves.toMatchObject({ added: true });
    await expect(loadDiscordMusicFavorites(10, filePath)).resolves.toHaveLength(1);
  });

  it("deletes and reorders favorites in the same order shown to the user", async () => {
    for (const title of ["A", "B", "C"]) {
      await saveDiscordMusicFavorite({ title, url: `https://example.com/${title}`, index: 1, total: 1 }, filePath);
    }
    let favorites = await loadDiscordMusicFavorites(10, filePath);
    expect(favorites.map((entry) => entry.title)).toEqual(["C", "B", "A"]);
    expect(await moveDiscordMusicFavorite(favorites[1].id, "up", filePath)).toBe(true);
    favorites = await loadDiscordMusicFavorites(10, filePath);
    expect(favorites.map((entry) => entry.title)).toEqual(["B", "C", "A"]);
    expect(await moveDiscordMusicFavorite(favorites[0].id, "up", filePath)).toBe(false);
    expect(await deleteDiscordMusicFavorite(favorites[1].id, filePath)).toBe(true);
    expect((await loadDiscordMusicFavorites(10, filePath)).map((entry) => entry.title)).toEqual(["B", "A"]);
  });

  it("deletes several selected favorites atomically", async () => {
    for (const title of ["A", "B", "C", "D"]) {
      await saveDiscordMusicFavorite({ title, url: `https://example.com/${title}`, index: 1, total: 1 }, filePath);
    }
    const favorites = await loadDiscordMusicFavorites(10, filePath);
    expect(await deleteDiscordMusicFavorites([favorites[0].id, favorites[2].id, favorites[2].id], filePath)).toBe(2);
    expect((await loadDiscordMusicFavorites(10, filePath)).map((entry) => entry.title)).toEqual(["C", "A"]);
  });

  it("manages multiple custom playlists", async () => {
    // 1. Initially only default playlist exists
    const playlists = await loadDiscordMusicPlaylists(filePath);
    expect(playlists).toHaveLength(1);
    expect(playlists[0].name).toBe("Bili/YT favorites");

    // 2. Create custom playlist
    const customList = await saveDiscordMusicPlaylist("My Study List", "https://example.com/playlist", [], filePath);
    expect(customList.name).toBe("My Study List");
    expect(customList.url).toBe("https://example.com/playlist");

    const playlistsAfterCreate = await loadDiscordMusicPlaylists(filePath);
    expect(playlistsAfterCreate).toHaveLength(2);
    expect(playlistsAfterCreate[1].id).toBe(customList.id);

    // 3. Save track to the custom playlist
    const track = { title: "Study Song", url: "https://example.com/study", index: 1, total: 1 };
    const saved = await saveDiscordMusicFavorite(track, customList.id, filePath);
    expect(saved.added).toBe(true);

    // Check tracks in custom list
    const customTracks = await loadDiscordMusicFavorites(10, customList.id, filePath);
    expect(customTracks).toHaveLength(1);
    expect(customTracks[0].title).toBe("Study Song");

    // Check tracks in default list (should remain empty/unchanged)
    const defaultTracks = await loadDiscordMusicFavorites(10, "default", filePath);
    expect(defaultTracks).toHaveLength(0);

    // 4. Delete custom playlist
    const deleted = await deleteDiscordMusicPlaylist(customList.id, filePath);
    expect(deleted).toBe(true);

    const playlistsAfterDelete = await loadDiscordMusicPlaylists(filePath);
    expect(playlistsAfterDelete).toHaveLength(1);
  });

  it("stores a Spotify playlist as one deduplicated link without copying its tracks", async () => {
    const url = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=test";
    const first = await saveDiscordMusicPlaylistLink("Today's Top Hits", url, undefined, filePath);
    const duplicate = await saveDiscordMusicPlaylistLink(
      "Duplicate title",
      "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
      undefined,
      filePath,
    );

    expect(first.added).toBe(true);
    expect(first.playlist).toMatchObject({
      name: "Today's Top Hits",
      url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
      folder: "spotify",
      tracks: [],
    });
    expect(duplicate).toMatchObject({ added: false, playlist: { id: first.playlist.id } });
    expect(await loadDiscordMusicPlaylists(filePath)).toHaveLength(2);
  });

  it("migrates account playlists into saved links once and never reimports deleted links", async () => {
    const links = [
      { name: "Best Wuwa Songs", url: "https://open.spotify.com/playlist/wuwa", total: 68 },
      { name: "JAPANESE FUNK", url: "https://open.spotify.com/playlist/funk", total: 47 },
    ];
    expect(await migrateDiscordSpotifyPlaylistLinks(links, filePath)).toBe(2);
    expect(await hasMigratedDiscordSpotifyPlaylistLinks(filePath)).toBe(true);
    const migrated = (await loadDiscordMusicPlaylists(filePath)).filter((playlist) => playlist.folder === "spotify");
    expect(migrated.map((playlist) => playlist.name)).toEqual(["Best Wuwa Songs", "JAPANESE FUNK"]);
    expect(await deleteDiscordMusicPlaylist(migrated[0].id, filePath)).toBe(true);
    expect(await migrateDiscordSpotifyPlaylistLinks(links, filePath)).toBe(0);
    expect((await loadDiscordMusicPlaylists(filePath)).map((playlist) => playlist.name)).not.toContain("Best Wuwa Songs");
  });

  it("allows a saved playlist name and link to be edited", async () => {
    const saved = await saveDiscordMusicPlaylistLink("Old name", "https://open.spotify.com/playlist/old", 12, filePath);
    const updated = await updateDiscordMusicPlaylist(saved.playlist.id, {
      name: "Night Drive",
      url: "https://open.spotify.com/playlist/new?si=ignored",
    }, filePath);
    expect(updated).toMatchObject({
      name: "Night Drive",
      url: "https://open.spotify.com/playlist/new",
      folder: "spotify",
    });
  });
});
