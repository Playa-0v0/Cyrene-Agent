import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearDiscordMusicResumeSession,
  loadDiscordMusicResumeData,
  saveDiscordMusicControllerReference,
  saveDiscordMusicResumeSession,
} from "./music-resume-store";

const directory = path.join(os.tmpdir(), `cyrene-resume-store-${process.pid}`);
const filePath = path.join(directory, "resume.json");

afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

describe("Discord music resume persistence", () => {
  it("keeps the playback checkpoint and controller message across restarts", async () => {
    await saveDiscordMusicResumeSession({
      current: { title: "unlasting — LiSA", url: "https://example.com/track", index: 47, total: 100, queueOrder: 47 },
      queue: [{ title: "Next", url: "https://example.com/next", index: 48, total: 100, queueOrder: 48 }],
      history: [], ownerId: "owner", volume: 100, repeat: "off", shuffle: true, autoplay: false,
      elapsed: 211, savedAt: "2026-07-28T15:00:00.000Z",
    }, filePath);
    await saveDiscordMusicControllerReference("channel-1", "message-1", filePath);

    expect(await loadDiscordMusicResumeData(filePath)).toMatchObject({
      session: { current: { title: "unlasting — LiSA" }, elapsed: 211 },
      controller: { channelId: "channel-1", messageId: "message-1" },
    });

    await clearDiscordMusicResumeSession(filePath);
    expect(await loadDiscordMusicResumeData(filePath)).toEqual({
      version: 1,
      controller: { channelId: "channel-1", messageId: "message-1" },
    });
  });
});
