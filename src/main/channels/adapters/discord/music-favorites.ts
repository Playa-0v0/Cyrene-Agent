import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { DiscordMusicTrack } from "./music-source";

const MAX_FAVORITE_ITEMS = 5000;

export interface DiscordMusicFavoriteEntry {
  id: string;
  title: string;
  url: string;
  thumbnail?: string;
  playlistTitle?: string;
  duration?: number;
  savedAt: string;
}

export interface DiscordMusicPlaylist {
  id: string;
  name: string;
  url?: string;
  /** Saved Spotify links live in their own visual folder; tracks are resolved only when played. */
  folder?: "spotify";
  tracks: DiscordMusicFavoriteEntry[];
  total?: number;
  createdAt: string;
}

export interface DiscordMusicFavoritesData {
  version: number;
  playlists: DiscordMusicPlaylist[];
}

let playlistsWriteQueue: Promise<void> = Promise.resolve();

export function getDiscordMusicFavoritesPath(): string {
  try {
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), "discord", "music-favorites.json");
    }
  } catch {}
  return "favorites.json";
}

function resolveArgs(
  playlistId: string | undefined,
  filePath: string | undefined,
  defaultPlaylist = "default"
): { playlistId: string; filePath: string } {
  let resolvedPlaylist = playlistId ?? defaultPlaylist;
  let resolvedPath = filePath ?? "";

  if (playlistId && (playlistId.endsWith(".json") || playlistId.includes("/") || playlistId.includes("\\"))) {
    resolvedPath = playlistId;
    resolvedPlaylist = defaultPlaylist;
  } else if (!resolvedPath) {
    resolvedPath = getDiscordMusicFavoritesPath();
  }
  return { playlistId: resolvedPlaylist, filePath: resolvedPath };
}

async function readPlaylistsData(filePath: string): Promise<DiscordMusicPlaylist[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Old format: flat array of tracks. Migrate to default playlist.
      const defaultPlaylist: DiscordMusicPlaylist = {
        id: "default",
        name: "Bili/YT favorites",
        tracks: parsed.filter((entry): entry is DiscordMusicFavoriteEntry => {
          const item = entry as Partial<DiscordMusicFavoriteEntry>;
          return typeof item.id === "string" && typeof item.title === "string"
            && typeof item.url === "string" && typeof item.savedAt === "string";
        }),
        createdAt: new Date().toISOString(),
      };
      return [defaultPlaylist];
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.playlists)) {
      return parsed.playlists.map((p: any) => ({
        id: String(p.id),
        name: String(p.name),
        url: p.url ? String(p.url) : undefined,
        folder: p.folder === "spotify" || /^https:\/\/open\.spotify\.com\/playlist\//i.test(String(p.url ?? ""))
          ? "spotify"
          : undefined,
        tracks: Array.isArray(p.tracks) ? p.tracks.filter((entry: any): entry is DiscordMusicFavoriteEntry => {
          const item = entry as Partial<DiscordMusicFavoriteEntry>;
          return typeof item.id === "string" && typeof item.title === "string"
            && typeof item.url === "string" && typeof item.savedAt === "string";
        }) : [],
        total: p.total !== undefined ? Number(p.total) : undefined,
        createdAt: p.createdAt ? String(p.createdAt) : new Date().toISOString(),
      }));
    }
    return [{ id: "default", name: "Bili/YT favorites", tracks: [], createdAt: new Date().toISOString() }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[DiscordMusicFavorites] 讀取失敗:", error);
    }
    return [{ id: "default", name: "Bili/YT favorites", tracks: [], createdAt: new Date().toISOString() }];
  }
}

async function writePlaylistsData(playlists: DiscordMusicPlaylist[], filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  const data: DiscordMusicFavoritesData = {
    version: 2,
    playlists: playlists.map(p => ({
      ...p,
      tracks: p.tracks.slice(-MAX_FAVORITE_ITEMS)
    }))
  };
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(temporary, filePath);
}

export async function loadDiscordMusicPlaylists(
  filePath = getDiscordMusicFavoritesPath(),
): Promise<DiscordMusicPlaylist[]> {
  return await readPlaylistsData(filePath);
}

export async function saveDiscordMusicPlaylist(
  name: string,
  url?: string,
  tracks: DiscordMusicTrack[] = [],
  filePath = getDiscordMusicFavoritesPath(),
): Promise<DiscordMusicPlaylist> {
  let result!: DiscordMusicPlaylist;
  const operation = playlistsWriteQueue.catch(() => undefined).then(async () => {
    const playlists = await readPlaylistsData(filePath);
    const id = randomUUID();
    const playlistTracks: DiscordMusicFavoriteEntry[] = tracks.map((track) => ({
      id: randomUUID(),
      title: track.title,
      url: track.url,
      thumbnail: track.thumbnail,
      playlistTitle: name,
      duration: track.duration,
      savedAt: new Date().toISOString(),
    }));
    const entry: DiscordMusicPlaylist = {
      id,
      name: name.trim() || `Custom List #${playlists.length + 1}`,
      url: url?.trim() || undefined,
      tracks: playlistTracks,
      createdAt: new Date().toISOString(),
    };
    playlists.push(entry);
    await writePlaylistsData(playlists, filePath);
    result = entry;
  });
  playlistsWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] 寫入歌單失敗:", error);
  });
  await operation;
  return result;
}

/** Save a Spotify playlist as a lightweight link instead of copying all tracks. */
export async function saveDiscordMusicPlaylistLink(
  name: string,
  url: string,
  total?: number,
  filePath = getDiscordMusicFavoritesPath(),
): Promise<{ added: boolean; playlist: DiscordMusicPlaylist }> {
  let result!: { added: boolean; playlist: DiscordMusicPlaylist };
  const normalizedUrl = url.trim().replace(/[?#].*$/, "").replace(/\/$/, "");
  const operation = playlistsWriteQueue.catch(() => undefined).then(async () => {
    const playlists = await readPlaylistsData(filePath);
    const existing = playlists.find((playlist) => playlist.url?.trim().replace(/[?#].*$/, "").replace(/\/$/, "") === normalizedUrl);
    if (existing) {
      if (total !== undefined && existing.total !== total) {
        existing.total = total;
        await writePlaylistsData(playlists, filePath);
      }
      result = { added: false, playlist: existing };
      return;
    }
    const playlist: DiscordMusicPlaylist = {
      id: randomUUID(),
      name: name.trim() || "Spotify Playlist",
      url: normalizedUrl,
      folder: "spotify",
      tracks: [],
      total,
      createdAt: new Date().toISOString(),
    };
    playlists.push(playlist);
    await writePlaylistsData(playlists, filePath);
    result = { added: true, playlist };
  });
  playlistsWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] 寫入 Spotify 歌單連結失敗:", error);
  });
  await operation;
  return result;
}

function spotifyMigrationMarker(filePath: string): string {
  return `${filePath}.spotify-links-v1`;
}

/**
 * One-time migration from the old account-scanned list to Cyrene-owned links.
 * The marker prevents deleted links from being silently imported again later.
 */
export async function migrateDiscordSpotifyPlaylistLinks(
  links: Array<{ name: string; url?: string; total?: number }>,
  filePath = getDiscordMusicFavoritesPath(),
): Promise<number> {
  try {
    await fs.access(spotifyMigrationMarker(filePath));
    return 0;
  } catch {}

  let addedCount = 0;
  const operation = playlistsWriteQueue.catch(() => undefined).then(async () => {
    const playlists = await readPlaylistsData(filePath);
    const knownUrls = new Set(playlists
      .map((playlist) => playlist.url?.trim().replace(/[?#].*$/, "").replace(/\/$/, ""))
      .filter((url): url is string => Boolean(url)));
    for (const link of links) {
      if (!link.url || !/^https:\/\/open\.spotify\.com\/playlist\//i.test(link.url)) continue;
      const normalizedUrl = link.url.trim().replace(/[?#].*$/, "").replace(/\/$/, "");
      if (knownUrls.has(normalizedUrl)) continue;
      playlists.push({
        id: randomUUID(),
        name: link.name.trim() || "Spotify Playlist",
        url: normalizedUrl,
        folder: "spotify",
        tracks: [],
        total: link.total,
        createdAt: new Date().toISOString(),
      });
      knownUrls.add(normalizedUrl);
      addedCount += 1;
    }
    await writePlaylistsData(playlists, filePath);
    await fs.writeFile(spotifyMigrationMarker(filePath), new Date().toISOString(), "utf8");
  });
  playlistsWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] Spotify 歌單連結遷移失敗:", error);
  });
  await operation;
  return addedCount;
}

export async function hasMigratedDiscordSpotifyPlaylistLinks(
  filePath = getDiscordMusicFavoritesPath(),
): Promise<boolean> {
  try {
    await fs.access(spotifyMigrationMarker(filePath));
    return true;
  } catch {
    return false;
  }
}

export async function deleteDiscordMusicPlaylist(
  id: string,
  filePath = getDiscordMusicFavoritesPath(),
): Promise<boolean> {
  let deleted = false;
  const operation = playlistsWriteQueue.catch(() => undefined).then(async () => {
    const playlists = await readPlaylistsData(filePath);
    const index = playlists.findIndex(p => p.id === id);
    if (index >= 0 && id !== "default") {
      playlists.splice(index, 1);
      await writePlaylistsData(playlists, filePath);
      deleted = true;
    }
  });
  playlistsWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] 刪除歌單失敗:", error);
  });
  await operation;
  return deleted;
}

export async function updateDiscordMusicPlaylist(
  id: string,
  input: { name: string; url?: string },
  filePath = getDiscordMusicFavoritesPath(),
): Promise<DiscordMusicPlaylist | null> {
  let updated: DiscordMusicPlaylist | null = null;
  const operation = playlistsWriteQueue.catch(() => undefined).then(async () => {
    const playlists = await readPlaylistsData(filePath);
    const playlist = playlists.find((item) => item.id === id);
    if (!playlist) return;
    playlist.name = input.name.trim() || playlist.name;
    if (input.url?.trim()) {
      playlist.url = input.url.trim().replace(/[?#].*$/, "").replace(/\/$/, "");
      playlist.folder = /^https:\/\/open\.spotify\.com\/playlist\//i.test(playlist.url) ? "spotify" : undefined;
    }
    await writePlaylistsData(playlists, filePath);
    updated = { ...playlist, tracks: playlist.tracks.map((track) => ({ ...track })) };
  });
  playlistsWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] 修改歌單失敗:", error);
  });
  await operation;
  return updated;
}

export async function loadDiscordMusicFavorites(
  limit = 100,
  playlistId = "default",
  filePath?: string,
): Promise<DiscordMusicFavoriteEntry[]> {
  const args = resolveArgs(playlistId, filePath);
  const playlists = await readPlaylistsData(args.filePath);
  const playlist = playlists.find(p => p.id === args.playlistId) || playlists[0];
  if (!playlist) return [];
  return playlist.tracks.slice(-Math.max(1, limit)).reverse();
}

export async function saveDiscordMusicFavorite(
  track: DiscordMusicTrack,
  playlistId = "default",
  filePath?: string,
): Promise<{ added: boolean; entry: DiscordMusicFavoriteEntry }> {
  const args = resolveArgs(playlistId, filePath);
  let result!: { added: boolean; entry: DiscordMusicFavoriteEntry };
  const operation = playlistsWriteQueue.catch(() => undefined).then(async () => {
    const playlists = await readPlaylistsData(args.filePath);
    let playlist = playlists.find(p => p.id === args.playlistId);
    if (!playlist) {
      playlist = playlists.find(p => p.id === "default") || playlists[0];
    }
    if (!playlist) {
      playlist = { id: "default", name: "Bili/YT favorites", tracks: [], createdAt: new Date().toISOString() };
      playlists.push(playlist);
    }
    const existing = playlist.tracks.find((entry) => entry.url === track.url);
    if (existing) {
      result = { added: false, entry: existing };
      return;
    }
    const entry: DiscordMusicFavoriteEntry = {
      id: randomUUID(),
      title: track.title,
      url: track.url,
      thumbnail: track.thumbnail,
      playlistTitle: playlist.name,
      duration: track.duration,
      savedAt: new Date().toISOString(),
    };
    playlist.tracks.push(entry);
    await writePlaylistsData(playlists, args.filePath);
    result = { added: true, entry };
  });
  playlistsWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] 寫入歌曲失敗:", error);
  });
  await operation;
  return result;
}

export async function saveDiscordMusicFavorites(
  tracks: DiscordMusicTrack[],
  playlistId = "default",
  filePath?: string,
): Promise<{ addedCount: number; playlistName: string }> {
  const args = resolveArgs(playlistId, filePath);
  let addedCount = 0;
  let playlistName = "";
  const operation = playlistsWriteQueue.catch(() => undefined).then(async () => {
    const playlists = await readPlaylistsData(args.filePath);
    let playlist = playlists.find(p => p.id === args.playlistId);
    if (!playlist) {
      playlist = playlists.find(p => p.id === "default") || playlists[0];
    }
    if (!playlist) {
      playlist = { id: "default", name: "Bili/YT favorites", tracks: [], createdAt: new Date().toISOString() };
      playlists.push(playlist);
    }
    playlistName = playlist.name;
    for (const track of tracks) {
      const existing = playlist.tracks.find((entry) => entry.url === track.url);
      if (existing) continue;
      playlist.tracks.push({
        id: randomUUID(),
        title: track.title,
        url: track.url,
        thumbnail: track.thumbnail,
        playlistTitle: playlist.name,
        duration: track.duration,
        savedAt: new Date().toISOString(),
      });
      addedCount++;
    }
    if (addedCount > 0) {
      await writePlaylistsData(playlists, args.filePath);
    }
  });
  playlistsWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] 批次寫入歌曲失敗:", error);
  });
  await operation;
  return { addedCount, playlistName };
}

export async function deleteDiscordMusicFavorites(
  ids: string[],
  playlistId = "default",
  filePath?: string,
): Promise<number> {
  const args = resolveArgs(playlistId, filePath);
  let deletedCount = 0;
  const operation = playlistsWriteQueue.catch(() => undefined).then(async () => {
    const playlists = await readPlaylistsData(args.filePath);
    const playlist = playlists.find(p => p.id === args.playlistId);
    if (!playlist) return;
    const targets = new Set(ids);
    const kept = playlist.tracks.filter((entry) => !targets.has(entry.id));
    deletedCount = playlist.tracks.length - kept.length;
    if (deletedCount > 0) {
      playlist.tracks.splice(0, playlist.tracks.length, ...kept);
      await writePlaylistsData(playlists, args.filePath);
    }
  });
  playlistsWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] 刪除歌曲失敗:", error);
  });
  await operation;
  return deletedCount;
}

export async function deleteDiscordMusicFavorite(
  id: string,
  playlistId = "default",
  filePath?: string,
): Promise<boolean> {
  const args = resolveArgs(playlistId, filePath);
  return (await deleteDiscordMusicFavorites([id], args.playlistId, args.filePath)) > 0;
}

export async function moveDiscordMusicFavorite(
  id: string,
  direction: "up" | "down",
  playlistId = "default",
  filePath?: string,
): Promise<boolean> {
  const args = resolveArgs(playlistId, filePath);
  let changed = false;
  const operation = playlistsWriteQueue.catch(() => undefined).then(async () => {
    const playlists = await readPlaylistsData(args.filePath);
    const playlist = playlists.find(p => p.id === args.playlistId);
    if (!playlist) return;
    const entries = playlist.tracks.reverse(); // Reverse for display order in old code
    const index = entries.findIndex((entry) => entry.id === id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index >= 0 && target >= 0 && target < entries.length) {
      [entries[index], entries[target]] = [entries[target], entries[index]];
      playlist.tracks = entries.reverse(); // Reverse back
      await writePlaylistsData(playlists, args.filePath);
      changed = true;
    } else {
      entries.reverse(); // Reset order
    }
  });
  playlistsWriteQueue = operation.catch((error) => {
    console.error("[DiscordMusicFavorites] 移動歌曲失敗:", error);
  });
  await operation;
  return changed;
}
