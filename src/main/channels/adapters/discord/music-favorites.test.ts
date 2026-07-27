import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { deleteDiscordMusicFavorite, deleteDiscordMusicFavorites, loadDiscordMusicFavorites, moveDiscordMusicFavorite, saveDiscordMusicFavorite } from "./music-favorites";

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
});
