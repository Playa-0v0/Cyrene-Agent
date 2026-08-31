export interface MusicCardTrack {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  coverUrl?: string;
}

export interface MusicCardData {
  setId: string;
  source: "daily_recommendation" | "search";
  tracks: MusicCardTrack[];
}

export function normalizeMusicCardData(value: unknown): MusicCardData | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { setId?: unknown; source?: unknown; tracks?: unknown };
  if (typeof raw.setId !== "string" || !raw.setId) return null;
  if (raw.source !== "daily_recommendation" && raw.source !== "search") return null;
  if (!Array.isArray(raw.tracks)) return null;
  const tracks = raw.tracks.flatMap((item): MusicCardTrack[] => {
    if (!item || typeof item !== "object") return [];
    const track = item as Record<string, unknown>;
    if (typeof track.id !== "string" || !track.id || typeof track.name !== "string" || !track.name) return [];
    const artists = Array.isArray(track.artists) ? track.artists.filter((artist): artist is string => typeof artist === "string") : [];
    return [{
      id: track.id,
      name: track.name,
      artists,
      album: typeof track.album === "string" ? track.album : undefined,
      coverUrl: typeof track.coverUrl === "string" ? track.coverUrl : undefined,
    }];
  }).slice(0, 5);
  if (tracks.length === 0) return null;
  return { setId: raw.setId, source: raw.source, tracks };
}
