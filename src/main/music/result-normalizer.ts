import { MusicInputError, type MusicTrack } from "./types";

interface UpstreamSong {
  id: string | number;
  name: string;
  artist?: string | string[];
  artists?: string | string[];
  album?: string;
  duration?: number;
  durationMs?: number;
  picUrl?: string;
  coverUrl?: string;
}

const MAX_TRACKS = 30;

function artistsOf(s: UpstreamSong): string[] {
  if (Array.isArray(s.artists)) return s.artists;
  if (typeof s.artists === "string") return [s.artists];
  if (Array.isArray(s.artist)) return s.artist;
  if (typeof s.artist === "string") return [s.artist];
  return [];
}

function toTrack(s: UpstreamSong): MusicTrack {
  return {
    id: String(s.id),
    name: s.name,
    artists: artistsOf(s),
    album: s.album,
    durationMs: s.durationMs ?? s.duration,
    coverUrl: s.coverUrl ?? s.picUrl,
  };
}

export function normalizeDailyRecommendations(payload: unknown): MusicTrack[] {
  const p = payload as {
    success?: boolean;
    songs?: UpstreamSong[];
    error?: string | { code?: string; message?: string };
  };
  if (!p || typeof p !== "object") {
    throw new MusicInputError("E_DAILY_RECOMMEND_INVALID_RESPONSE");
  }
  if (!p.success) {
    const error = p.error;
    const code = typeof error === "object" && error?.code
      ? error.code
      : "E_DAILY_RECOMMEND_FAILED";
    const message = typeof error === "object" ? error?.message : error;
    throw new MusicInputError(code, `${code}: ${message || "unknown error"}`);
  }
  if (!Array.isArray(p.songs)) {
    throw new MusicInputError("E_DAILY_RECOMMEND_INVALID_RESPONSE");
  }
  return p.songs.slice(0, MAX_TRACKS).map(toTrack);
}

export function normalizeSearchResults(payload: unknown): MusicTrack[] {
  if (Array.isArray(payload)) {
    return (payload as UpstreamSong[]).slice(0, MAX_TRACKS).map(toTrack);
  }
  const p = payload as { success?: boolean; items?: UpstreamSong[]; error?: string };
  if (!p?.success || !Array.isArray(p.items)) return [];
  return p.items.slice(0, MAX_TRACKS).map(toTrack);
}
