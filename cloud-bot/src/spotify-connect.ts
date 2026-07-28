import type { CloudBotConfig } from "./config.js";

type SpotifyConfig = Pick<CloudBotConfig, "spotifyClientId" | "spotifyClientSecret" | "spotifyRefreshToken">;

function spotifyUriFromInput(input: string): string | null {
  const value = input.trim();
  if (/^spotify:(?:track|album|playlist):[A-Za-z0-9]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname !== "open.spotify.com") return null;
    const [type, id] = url.pathname.split("/").filter(Boolean);
    return id && ["track", "album", "playlist"].includes(type) ? `spotify:${type}:${id}` : null;
  } catch {
    return null;
  }
}

async function accessToken(config: SpotifyConfig): Promise<string> {
  const clientId = config.spotifyClientId?.trim();
  const clientSecret = config.spotifyClientSecret?.trim();
  const refreshToken = config.spotifyRefreshToken?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("雲端尚未設定 Spotify Connect 憑證；請設定 SPOTIFY_CLIENT_ID、SPOTIFY_CLIENT_SECRET、SPOTIFY_REFRESH_TOKEN");
  }
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as { access_token?: string; error_description?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || `Spotify 授權失敗（HTTP ${response.status}）`);
  return payload.access_token;
}

async function spotifyApi<T>(token: string, path: string, init: RequestInit = {}): Promise<T | null> {
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `Spotify API 錯誤（HTTP ${response.status}）`);
  return payload;
}

export async function playOnSpotify(config: SpotifyConfig, input: string): Promise<void> {
  const token = await accessToken(config);
  let uri = spotifyUriFromInput(input);
  if (!uri) {
    const params = new URLSearchParams({ q: input.trim(), type: "track", limit: "1", market: "TW" });
    const result = await spotifyApi<{ tracks?: { items?: Array<{ uri?: string }> } }>(token, `/search?${params}`);
    uri = result?.tracks?.items?.[0]?.uri ?? null;
  }
  if (!uri) throw new Error("Spotify 找不到這首歌，請改貼 Spotify 連結");
  const isTrack = uri.startsWith("spotify:track:");
  await spotifyApi(token, "/me/player/play", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(isTrack ? { uris: [uri] } : { context_uri: uri }),
  });
}
