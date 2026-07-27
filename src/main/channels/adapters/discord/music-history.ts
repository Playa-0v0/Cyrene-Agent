import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { DiscordMusicTrack } from "./music-source";

const MAX_HISTORY_ITEMS = 500;

export interface DiscordMusicHistoryEntry {
  id: string;
  title: string;
  url: string;
  thumbnail?: string;
  playlistTitle?: string;
  playedAt: string;
}

let historyWriteQueue: Promise<void> = Promise.resolve();

export function getDiscordMusicHistoryPath(): string {
  return path.join(app.getPath("userData"), "discord", "music-history.json");
}

async function readHistory(filePath: string): Promise<DiscordMusicHistoryEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is DiscordMusicHistoryEntry => {
      const item = entry as Partial<DiscordMusicHistoryEntry>;
      return typeof item.id === "string" && typeof item.title === "string"
        && typeof item.url === "string" && typeof item.playedAt === "string";
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[DiscordMusicHistory] 讀取失敗:", error);
    return [];
  }
}

export async function loadDiscordMusicHistory(
  limit = 25,
  filePath = getDiscordMusicHistoryPath(),
): Promise<DiscordMusicHistoryEntry[]> {
  const history = await readHistory(filePath);
  return history.slice(-Math.max(1, limit)).reverse();
}

export function recordDiscordMusicHistory(
  track: DiscordMusicTrack,
  filePath = getDiscordMusicHistoryPath(),
): Promise<void> {
  historyWriteQueue = historyWriteQueue.then(async () => {
    const history = await readHistory(filePath);
    history.push({
      id: randomUUID(),
      title: track.title,
      url: track.url,
      thumbnail: track.thumbnail,
      playlistTitle: track.playlistTitle,
      playedAt: new Date().toISOString(),
    });
    const bounded = history.slice(-MAX_HISTORY_ITEMS);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(bounded, null, 2), "utf8");
    await fs.rename(temporary, filePath);
  }).catch((error) => console.error("[DiscordMusicHistory] 寫入失敗:", error));
  return historyWriteQueue;
}
