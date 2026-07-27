import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDiscordMusicHistory, recordDiscordMusicHistory } from "./music-history";

const directory = path.join(os.tmpdir(), `cyrene-music-history-${process.pid}`);
const filePath = path.join(directory, "history.json");

afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

describe("Discord music history", () => {
  it("persists played tracks newest first", async () => {
    await recordDiscordMusicHistory({ title: "First", url: "https://example.com/1", index: 1, total: 2 }, filePath);
    await recordDiscordMusicHistory({ title: "Second", url: "https://example.com/2", playlistTitle: "Mix", index: 2, total: 2 }, filePath);
    const history = await loadDiscordMusicHistory(10, filePath);
    expect(history.map((entry) => entry.title)).toEqual(["Second", "First"]);
    expect(history[0]).toMatchObject({ url: "https://example.com/2", playlistTitle: "Mix" });
  });

  it("returns an empty list when no history exists", async () => {
    expect(await loadDiscordMusicHistory(10, filePath)).toEqual([]);
  });
});
