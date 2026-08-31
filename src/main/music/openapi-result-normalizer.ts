// OpenAPI response → internal types (MusicTrack / MusicPlaylist / ...).
// Dual-id contract: `id` = encrypted 32-hex (API ops), `originalId` = numeric (links).
import type { MusicTrack, MusicPlaylist, MusicPlaylistDetail, MusicProfile, MusicSubscription } from "./types";
import { MusicInputError } from "./types";
import type { OpenapiSongRecord, OpenapiPlaylistRecord, OpenapiUserProfile, OpenapiSongDetail } from "./netease-openapi-client";

const MAX_TRACKS = 30;

/**
 * Song record → MusicTrack. Returns null for unplayable songs
 * (official SKILL.md: visible:false must be filtered out).
 */
export function normalizeSongRecord(rec: OpenapiSongRecord): MusicTrack | null {
  if (!rec || typeof rec !== "object") return null;
  if (rec.visible === false) return null;
  const encryptedId = typeof rec.id === "string" ? rec.id : "";
  if (!encryptedId) return null;
  const artists = Array.isArray(rec.artists)
    ? rec.artists.map((a) => a?.name).filter((n): n is string => typeof n === "string")
    : [];
  return {
    id: encryptedId,
    encryptedId,
    originalId: typeof rec.originalId === "number" ? rec.originalId : undefined,
    name: rec.name ?? "",
    artists,
    album: typeof rec.albumName === "string" ? rec.albumName : undefined,
    durationMs: typeof rec.duration === "number" ? rec.duration : undefined,
    coverUrl: typeof rec.coverImgUrl === "string" ? rec.coverImgUrl : undefined,
  };
}

export function normalizeSongRecords(recs: OpenapiSongRecord[] | undefined | null, max = MAX_TRACKS): MusicTrack[] {
  if (!Array.isArray(recs)) return [];
  const out: MusicTrack[] = [];
  for (const rec of recs) {
    const t = normalizeSongRecord(rec);
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Song detail (getSongDetail with playUrl) → MusicTrack. */
export function normalizeSongDetail(songId: string, detail: OpenapiSongDetail): MusicTrack {
  return {
    id: songId,
    encryptedId: songId,
    name: detail?.name ?? "",
    artists: typeof detail?.artistName === "string" && detail.artistName ? [detail.artistName] : [],
    album: typeof detail?.albumName === "string" ? detail.albumName : undefined,
    durationMs: typeof detail?.duration === "number" ? detail.duration : undefined,
    coverUrl: typeof detail?.coverImgUrl === "string" ? detail.coverImgUrl : undefined,
  };
}

export function normalizePlaylistRecord(pl: OpenapiPlaylistRecord): MusicPlaylist | null {
  if (!pl || typeof pl !== "object") return null;
  const id = typeof pl.id === "string" && pl.id ? pl.id : "";
  if (!id) return null;
  return {
    id,
    originalId: typeof pl.originalId === "number" ? pl.originalId : undefined,
    name: pl.name ?? "",
    coverUrl: typeof pl.coverImgUrl === "string" ? pl.coverImgUrl : undefined,
    trackCount: typeof pl.trackCount === "number" ? pl.trackCount : 0,
    creator: typeof pl.creatorNickName === "string" ? pl.creatorNickName : undefined,
  };
}

export function normalizePlaylistRecords(
  pls: OpenapiPlaylistRecord[] | undefined | null,
  max = 50,
): MusicPlaylist[] {
  if (!Array.isArray(pls)) return [];
  const out: MusicPlaylist[] = [];
  for (const pl of pls) {
    const p = normalizePlaylistRecord(pl);
    if (p) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** Playlist detail endpoint + tracks endpoint → MusicPlaylistDetail. */
export function normalizePlaylistDetail(
  pl: OpenapiPlaylistRecord,
  tracks: OpenapiSongRecord[],
): MusicPlaylistDetail {
  const base = normalizePlaylistRecord(pl);
  return {
    id: base?.id ?? "",
    originalId: base?.originalId,
    name: base?.name ?? "",
    coverUrl: base?.coverUrl,
    trackCount: base?.trackCount ?? 0,
    creator: base?.creator,
    description: typeof pl?.describe === "string" ? pl.describe : undefined,
    tracks: normalizeSongRecords(tracks),
  };
}

export function normalizeUserProfile(profile: OpenapiUserProfile): MusicProfile | null {
  if (!profile?.nickname) return null;
  return {
    userId: profile.userId !== undefined ? String(profile.userId) : "",
    nickname: profile.nickname,
    avatarUrl: typeof profile.avatarUrl === "string" ? profile.avatarUrl : undefined,
  };
}

/**
 * Subscribed albums (album/subed/get/v2 — contract from manifest, response
 * shape not live-tested in M0). Defensive: unknown shapes yield [].
 */
export function normalizeSubscribedAlbums(payload: unknown): MusicSubscription[] {
  const records =
    payload && typeof payload === "object" && Array.isArray((payload as { records?: unknown[] }).records)
      ? ((payload as { records: unknown[] }).records as Array<Record<string, unknown>>)
      : Array.isArray(payload)
        ? (payload as Array<Record<string, unknown>>)
        : [];
  const out: MusicSubscription[] = [];
  for (const rec of records) {
    const id = typeof rec?.id === "string" ? rec.id : undefined;
    const name =
      typeof rec?.name === "string" ? rec.name
      : typeof rec?.albumName === "string" ? rec.albumName
      : undefined;
    if (!id || !name) continue;
    out.push({
      id,
      name,
      coverUrl: typeof rec?.coverImgUrl === "string" ? rec.coverImgUrl : typeof rec?.picUrl === "string" ? rec.picUrl : undefined,
    });
  }
  return out;
}

/** addToPlaylist response (untested write) — defensive count, fallback to requested. */
export function normalizeAddToPlaylistResult(
  payload: unknown,
  requested: number,
  playlistId: string,
): { added: number; playlistId: string } {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const key of ["count", "addedCount", "added_count", "successCount"]) {
      if (typeof p[key] === "number") return { added: p[key] as number, playlistId };
    }
  }
  return { added: requested, playlistId };
}

/** removeSongs response (untested write) — same defensive-count shape as add. */
export function normalizeRemoveFromPlaylistResult(
  payload: unknown,
  requested: number,
  playlistId: string,
): { removed: number; playlistId: string } {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const key of ["count", "removedCount", "removed_count", "successCount"]) {
      if (typeof p[key] === "number") return { removed: p[key] as number, playlistId };
    }
  }
  return { removed: requested, playlistId };
}

/** Validates a 32-hex encrypted id before any API call (kills抄错/截断 ids early). */
export function assertEncryptedId(id: string): string {
  if (!/^[0-9A-Fa-f]{32}$/.test(id)) {
    throw new MusicInputError(
      "E_INVALID_ENCRYPTED_ID",
      `E_INVALID_ENCRYPTED_ID: expected 32-hex, got: ${id.slice(0, 40)}`,
    );
  }
  return id;
}
