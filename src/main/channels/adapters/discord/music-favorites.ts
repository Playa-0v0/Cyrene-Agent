import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { DiscordMusicTrack } from "./music-source";

const MAX_FAVORITE_ITEMS = 500;

export interface DiscordMusicFavoriteEntry {
  id: string;
  title: string;
  url: string;
  thumbnail?: string;
  playlistTitle?: string;
  duration?: number;
  savedAt: string;
}

let favoritesWriteQueue: Promise<void> = Promise.resolve();

export function getDiscordMusicFavoritesPath(): string {
  return path.join(app.getPath("userData"), "discord", "music-favorites.json");
}

async function readFavorites(filePath: string): Promise<DiscordMusicFavoriteEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is DiscordMusicFavoriteEntry => {
      const item = entry as Partial<DiscordMusicFavoriteEntry>;
      return typeof item.id === "string" && typeof item.title === "string"
        && typeof item.url === "string" && typeof item.savedAt === "string";
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[DiscordMusicFavorites] 讀取失敗:", error);
    }
    return [];
  }
}

async function writeFavorites(entries: DiscordMusicFavoriteEntry[], filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(entries.slice(-MAX_FAVORITE_ITEMS), null, 2), "utf8");
  await fs.rename(temporary, filePath);
}

export async function loadDiscordMusicFavorites(
  limit = 100,
  filePath = getDiscordMusicFavoritesPath(),
): Promise<DiscordMusicFavoriteEntry[]> {
  const favorites = await readFavorites(filePath);
  return favorites.slice(-Math.max(1, limit)).reverse();
}

export async function saveDiscordMusicFavorite(
  track: DiscordMusicTrack,
  filePath = getDiscordMusicFavoritesPath(),
): Promise<{ added: boolean; entry: DiscordMusicFavoriteEntry }> {
  let result!: { added: boolean; entry: DiscordMusicFavoriteEntry };
  const operation = favoritesWriteQueue.catch(() => undefined).then(async () => {
    const favorites = await readFavorites(filePath);
    const existing = favorites.find((entry) => entry.url === track.url);
    if (existing) {
      result = { added: false, entry: existing };
      return;
    }
    const entry: DiscordMusicFavoriteEntry = {
      id: randomUUID(),
      title: track.title,
      url: track.url,
      thumbnail: track.thumbnail,
      playlistTitle: track.playlistTitle,
      duration: track.duration,
      savedAt: new Date().toISOString(),
    };
    favorites.push(entry);
    await writeFavorites(favorites, filePath);
    result = { added: true, entry };
  });
  favoritesWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] 寫入失敗:", error);
  });
  await operation;
  return result;
}

async function editDiscordMusicFavorites(
  edit: (displayOrder: DiscordMusicFavoriteEntry[]) => boolean,
  filePath = getDiscordMusicFavoritesPath(),
): Promise<boolean> {
  let changed = false;
  const operation = favoritesWriteQueue.catch(() => undefined).then(async () => {
    const displayOrder = (await readFavorites(filePath)).reverse();
    changed = edit(displayOrder);
    if (changed) await writeFavorites(displayOrder.reverse(), filePath);
  });
  favoritesWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] 編輯失敗:", error);
  });
  await operation;
  return changed;
}

export async function deleteDiscordMusicFavorite(
  id: string,
  filePath = getDiscordMusicFavoritesPath(),
): Promise<boolean> {
  return (await deleteDiscordMusicFavorites([id], filePath)) > 0;
}

export async function deleteDiscordMusicFavorites(
  ids: string[],
  filePath = getDiscordMusicFavoritesPath(),
): Promise<number> {
  const targets = new Set(ids);
  let deleted = 0;
  await editDiscordMusicFavorites((entries) => {
    const kept = entries.filter((entry) => !targets.has(entry.id));
    deleted = entries.length - kept.length;
    if (!deleted) return false;
    entries.splice(0, entries.length, ...kept);
    return true;
  }, filePath);
  return deleted;
}

export async function moveDiscordMusicFavorite(
  id: string,
  direction: "up" | "down",
  filePath = getDiscordMusicFavoritesPath(),
): Promise<boolean> {
  return await editDiscordMusicFavorites((entries) => {
    const index = entries.findIndex((entry) => entry.id === id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= entries.length) return false;
    [entries[index], entries[target]] = [entries[target], entries[index]];
    return true;
  }, filePath);
}
