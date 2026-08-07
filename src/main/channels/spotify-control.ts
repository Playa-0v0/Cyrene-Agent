import { randomBytes } from "node:crypto";
import { shell } from "electron";
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";
import { registerLocalGetRoute } from "./inbound-server";
import { buildSpotifySearchQuery, type DiscordMusicTrack } from "./adapters/discord/music-source";
import { toTraditionalTaiwan } from "../utils/opencc";

export const SPOTIFY_REDIRECT_URI = "http://127.0.0.1:53854/spotify/callback";
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-private",
  "user-read-email",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state",
  "streaming",
].join(" ");

interface SpotifyTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export interface SpotifyPlaybackStatus {
  configured: boolean;
  connected: boolean;
  accountName?: string;
  product?: string;
  error?: string;
  playback?: {
    active: boolean;
    paused: boolean;
    progressMs: number;
    durationMs: number;
    title?: string;
    artists?: string;
    album?: string;
    imageUrl?: string;
    deviceName?: string;
    volume?: number;
  };
  devices: Array<{ id: string; name: string; type: string; active: boolean; volume?: number }>;
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  url: string;
  imageUrl?: string;
  total: number;
  owner?: string;
}

export interface SpotifyArtistSummary {
  id: string;
  name: string;
  url: string;
  imageUrl?: string;
  followers?: number;
}

let accessToken = "";
let accessTokenExpiresAt = 0;
let accessTokenRefresh: Promise<string> | null = null;
let expectedState = "";
let lastAuthError = "";

function credentials(): { clientId: string; clientSecret: string; refreshToken: string } {
  const cfg = loadChannelsSettings().spotify;
  return {
    clientId: cfg.clientId?.trim() ?? "",
    clientSecret: cfg.clientSecret ?? "",
    refreshToken: cfg.refreshToken ?? "",
  };
}

async function tokenRequest(body: URLSearchParams): Promise<SpotifyTokenResponse> {
  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) throw new Error("請先填入 Spotify Client ID 與 Client Secret");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as SpotifyTokenResponse & { error_description?: string; error?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `Spotify 授權失敗（HTTP ${response.status}）`);
  }
  return payload;
}

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessTokenExpiresAt - 30_000) return accessToken;
  if (accessTokenRefresh) return accessTokenRefresh;
  accessTokenRefresh = (async () => {
    const { clientId, clientSecret, refreshToken } = credentials();
    if (refreshToken) {
      const token = await tokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
      accessToken = token.access_token;
      accessTokenExpiresAt = Date.now() + Math.max(60, token.expires_in) * 1000;
      if (token.refresh_token) saveChannelsSettings({ spotify: { enabled: true, refreshToken: token.refresh_token } });
      return accessToken;
    }
    if (clientId && clientSecret) {
      const token = await tokenRequest(new URLSearchParams({ grant_type: "client_credentials" }));
      accessToken = token.access_token;
      accessTokenExpiresAt = Date.now() + Math.max(60, token.expires_in) * 1000;
      return accessToken;
    }
    const response = await fetch("https://open.spotify.com/get_access_token?reason=transport&productType=web_player", {
      headers: { "user-agent": "Mozilla/5.0 CyreneDiscordBot/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Spotify 尚未完成帳號授權`);
    const payload = await response.json() as { accessToken?: string; accessTokenExpirationTimestampMs?: number };
    if (!payload.accessToken) throw new Error("Spotify 尚未完成帳號授權");
    accessToken = payload.accessToken;
    accessTokenExpiresAt = payload.accessTokenExpirationTimestampMs ?? (Date.now() + 3600_000);
    return accessToken;
  })();
  try {
    return await accessTokenRefresh;
  } finally {
    accessTokenRefresh = null;
  }
}

async function spotifyApi<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const token = await getAccessToken();
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

function finishCallback(status: number, title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#121212;color:#fff;font:16px system-ui}.card{max-width:520px;padding:32px;border-radius:22px;background:#202020;border:1px solid #333}.ok{color:#1ed760}</style><div class="card"><h1 class="${status === 200 ? "ok" : ""}">${title}</h1><p>${message}</p><p>你可以關閉這個分頁，回到 Cyrene。</p></div>`;
}

export async function startSpotifyAuthorization(input: { clientId?: string; clientSecret?: string }): Promise<{ ok: boolean; message?: string; error?: string }> {
  const clientId = input.clientId?.trim() || loadChannelsSettings().spotify.clientId?.trim() || "";
  const clientSecret = input.clientSecret || loadChannelsSettings().spotify.clientSecret || "";
  if (!clientId || !clientSecret) return { ok: false, error: "請先填入 Spotify Client ID 與 Client Secret" };
  saveChannelsSettings({ spotify: { enabled: true, clientId, clientSecret } });
  accessToken = "";
  expectedState = randomBytes(24).toString("hex");
  lastAuthError = "";
  registerLocalGetRoute("/spotify/callback", async (request, response) => {
    const url = new URL(request.url ?? "/", SPOTIFY_REDIRECT_URI);
    try {
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error) throw new Error(`Spotify 拒絕授權：${error}`);
      if (!code || state !== expectedState) throw new Error("Spotify 回傳的授權狀態無效，請重新連線");
      const token = await tokenRequest(new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }));
      accessToken = token.access_token;
      accessTokenExpiresAt = Date.now() + Math.max(60, token.expires_in) * 1000;
      const profile = await spotifyApi<{ display_name?: string; email?: string; product?: string }>("/me");
      saveChannelsSettings({
        spotify: {
          enabled: true,
          refreshToken: token.refresh_token,
          accountName: profile?.display_name || profile?.email || "Spotify Premium",
        },
      });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(finishCallback(200, "Spotify 已連接", "Cyrene 現在可以控制你帳號上的 Spotify 播放器。"));
    } catch (err) {
      lastAuthError = err instanceof Error ? err.message : String(err);
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end(finishCallback(400, "連接失敗", lastAuthError));
    }
  });

  const authorize = new URL("https://accounts.spotify.com/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", SPOTIFY_REDIRECT_URI);
  authorize.searchParams.set("scope", SCOPES);
  authorize.searchParams.set("state", expectedState);
  authorize.searchParams.set("show_dialog", "true");
  await shell.openExternal(authorize.toString());
  return { ok: true, message: "已開啟 Spotify 授權頁，完成後回到 Cyrene" };
}

export async function getSpotifyStatus(): Promise<SpotifyPlaybackStatus> {
  const cfg = loadChannelsSettings().spotify;
  const base: SpotifyPlaybackStatus = {
    configured: Boolean(cfg.clientId && cfg.clientSecret),
    connected: Boolean(cfg.refreshToken),
    accountName: cfg.accountName,
    devices: [],
  };
  if (lastAuthError) base.error = lastAuthError;
  if (!base.connected) return base;
  try {
    const [profile, player, devices] = await Promise.all([
      spotifyApi<{ display_name?: string; email?: string; product?: string }>("/me"),
      spotifyApi<{
        is_playing: boolean;
        progress_ms?: number;
        device?: { name?: string; volume_percent?: number };
        item?: { name?: string; duration_ms?: number; artists?: Array<{ name: string }>; album?: { name?: string; images?: Array<{ url: string }> } };
      }>("/me/player"),
      spotifyApi<{ devices?: Array<{ id?: string; name: string; type: string; is_active: boolean; volume_percent?: number }> }>("/me/player/devices"),
    ]);
    base.accountName = profile?.display_name || profile?.email || cfg.accountName;
    base.product = profile?.product;
    base.devices = (devices?.devices ?? []).filter((device) => device.id).map((device) => ({
      id: device.id!, name: device.name, type: device.type, active: device.is_active, volume: device.volume_percent,
    }));
    base.playback = {
      active: Boolean(player?.item),
      paused: player ? !player.is_playing : false,
      progressMs: player?.progress_ms ?? 0,
      durationMs: player?.item?.duration_ms ?? 0,
      title: player?.item?.name,
      artists: player?.item?.artists?.map((artist) => artist.name).join("、"),
      album: player?.item?.album?.name,
      imageUrl: player?.item?.album?.images?.[0]?.url,
      deviceName: player?.device?.name,
      volume: player?.device?.volume_percent,
    };
    return base;
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

export function spotifyUriFromInput(input: string): string | null {
  const value = input.trim();
  if (/^spotify:(track|album|playlist):[A-Za-z0-9]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname !== "open.spotify.com") return null;
    const [type, id] = url.pathname.split("/").filter(Boolean);
    if (!id || !["track", "album", "playlist"].includes(type)) return null;
    return `spotify:${type}:${id}`;
  } catch {
    return null;
  }
}

export async function getSpotifyPlaylists(limit = 25): Promise<SpotifyPlaylistSummary[]> {
  const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));
  const payload = await spotifyApi<{
    items?: Array<{
      id?: string;
      name?: string;
      external_urls?: { spotify?: string };
      images?: Array<{ url?: string }>;
      tracks?: { total?: number };
      items?: { total?: number };
      owner?: { display_name?: string };
    } | null>;
  }>(`/me/playlists?limit=${safeLimit}`);
  return (payload?.items ?? [])
    .filter((item): item is NonNullable<typeof item> & { id: string; name: string } => Boolean(item?.id && item.name))
    .map((item) => ({
      id: item.id,
      name: toTraditionalTaiwan(item.name),
      url: item.external_urls?.spotify ?? `https://open.spotify.com/playlist/${item.id}`,
      imageUrl: item.images?.[0]?.url,
      total: item.tracks?.total ?? item.items?.total ?? 0,
      owner: item.owner?.display_name ? toTraditionalTaiwan(item.owner.display_name) : undefined,
    }));
}

export async function getSpotifyPlaylistTracks(
  playlist: SpotifyPlaylistSummary,
  maxItems = 5000,
): Promise<DiscordMusicTrack[]> {
  const collected: Array<{
    id: string;
    name: string;
    artists: string;
    url: string;
    imageUrl?: string;
    duration?: number;
  }> = [];
  const safeMax = Math.max(1, Math.min(5000, Math.floor(maxItems)));
  for (let offset = 0; offset < safeMax; offset += 100) {
    const limit = Math.min(100, safeMax - offset);
    const payload = await spotifyApi<{
      items?: Array<{
        item?: {
          id?: string;
          name?: string;
          duration_ms?: number;
          artists?: Array<{ name?: string }>;
          external_urls?: { spotify?: string };
          album?: { images?: Array<{ url?: string }> };
        } | null;
        track?: {
          id?: string;
          name?: string;
          duration_ms?: number;
          artists?: Array<{ name?: string }>;
          external_urls?: { spotify?: string };
          album?: { images?: Array<{ url?: string }> };
        } | null;
      } | null>;
      next?: string | null;
    }>(`/playlists/${encodeURIComponent(playlist.id)}/items?limit=${limit}&offset=${offset}`);
    const items = payload?.items ?? [];
    for (const item of items) {
      const track = item?.item || item?.track;
      if (!track?.id || !track.name) continue;
      collected.push({
        id: track.id,
        name: toTraditionalTaiwan(track.name),
        artists: toTraditionalTaiwan(track.artists?.map((artist) => artist.name).filter(Boolean).join("、") ?? ""),
        url: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
        imageUrl: track.album?.images?.[0]?.url ?? playlist.imageUrl,
        duration: typeof track.duration_ms === "number" ? Math.round(track.duration_ms / 1000) : undefined,
      });
    }
    if (!payload?.next || items.length < limit) break;
  }
  return collected.map((track, index, tracks) => ({
    id: track.id,
    title: track.artists ? `${track.name} — ${track.artists}` : track.name,
    url: track.url,
    playbackUrl: `ytsearch1:${buildSpotifySearchQuery(track.name, track.artists)}`,
    thumbnail: track.imageUrl,
    playlistTitle: playlist.name,
    playlistUrl: playlist.url,
    duration: track.duration,
    index: index + 1,
    total: tracks.length,
  }));
}

export async function searchSpotifyArtists(query: string, limit = 10): Promise<SpotifyArtistSummary[]> {
  const safeQuery = query.trim();
  if (!safeQuery) return [];
  const safeLimit = Math.max(1, Math.min(10, Math.floor(limit)));
  const params = new URLSearchParams({ q: safeQuery, type: "artist", limit: String(safeLimit), market: "TW" });
  const payload = await spotifyApi<{
    artists?: {
      items?: Array<{
        id?: string;
        name?: string;
        external_urls?: { spotify?: string };
        images?: Array<{ url?: string }>;
        followers?: { total?: number };
      } | null>;
    };
  }>(`/search?${params}`);
  return (payload?.artists?.items ?? [])
    .filter((artist): artist is NonNullable<typeof artist> & { id: string; name: string } => Boolean(artist?.id && artist.name))
    .map((artist) => ({
      id: artist.id,
      name: toTraditionalTaiwan(artist.name),
      url: artist.external_urls?.spotify ?? `https://open.spotify.com/artist/${artist.id}`,
      imageUrl: artist.images?.[0]?.url,
      followers: artist.followers?.total,
    }));
}

export async function getSpotifyArtistTopTracks(artistId: string): Promise<DiscordMusicTrack[]> {
  const safeId = artistId.trim();
  if (!/^[A-Za-z0-9]+$/.test(safeId)) throw new Error("Spotify 作者 ID 無效");
  const [artist, payload] = await Promise.all([
    spotifyApi<{ name?: string; images?: Array<{ url?: string }> }>(`/artists/${encodeURIComponent(safeId)}`),
    spotifyApi<{
      tracks?: Array<{
        id?: string;
        name?: string;
        duration_ms?: number;
        artists?: Array<{ name?: string }>;
        external_urls?: { spotify?: string };
        album?: { images?: Array<{ url?: string }> };
      } | null>;
    }>(`/artists/${encodeURIComponent(safeId)}/top-tracks?market=TW`),
  ]);
  const artistName = toTraditionalTaiwan(artist?.name?.trim() || "Spotify 作者熱門歌曲");
  const tracks = (payload?.tracks ?? [])
    .filter((track): track is NonNullable<typeof track> & { id: string; name: string } => Boolean(track?.id && track.name));
  return tracks.map((track, index) => {
    const title = toTraditionalTaiwan(track.name);
    const artists = toTraditionalTaiwan(track.artists?.map((item) => item.name).filter(Boolean).join("、") ?? "");
    return {
      id: track.id,
      title: artists ? `${title} — ${artists}` : title,
      url: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
      playbackUrl: `ytsearch1:${buildSpotifySearchQuery(title, artists)}`,
      thumbnail: track.album?.images?.[0]?.url ?? artist?.images?.[0]?.url,
      playlistTitle: `${artistName} · 熱門歌曲`,
      duration: typeof track.duration_ms === "number" ? Math.round(track.duration_ms / 1000) : undefined,
      index: index + 1,
      total: tracks.length,
    };
  });
}

export async function searchSpotifyTracks(query: string, limit = 5): Promise<DiscordMusicTrack[]> {
  const safeQuery = query.trim();
  if (!safeQuery) return [];
  const safeLimit = Math.max(1, Math.min(10, Math.floor(limit)));
  const params = new URLSearchParams({ q: safeQuery, type: "track", limit: String(safeLimit) });
  const payload = await spotifyApi<{
    tracks?: {
      items?: Array<{
        id?: string;
        name?: string;
        duration_ms?: number;
        artists?: Array<{ name?: string }>;
        external_urls?: { spotify?: string };
        album?: { images?: Array<{ url?: string }> };
      } | null>;
    };
  }>(`/search?${params}`);

  const tracks = (payload?.tracks?.items ?? [])
    .filter((track): track is NonNullable<typeof track> & { id: string; name: string } => Boolean(track?.id && track.name));

  return tracks.map((track, index) => {
    const title = toTraditionalTaiwan(track.name);
    const artists = toTraditionalTaiwan(track.artists?.map((item) => item.name).filter(Boolean).join("、") ?? "");
    return {
      id: track.id,
      title: artists ? `${title} — ${artists}` : title,
      url: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
      playbackUrl: `ytsearch1:${buildSpotifySearchQuery(title, artists)}`,
      thumbnail: track.album?.images?.[0]?.url,
      duration: typeof track.duration_ms === "number" ? Math.round(track.duration_ms / 1000) : undefined,
      index: index + 1,
      total: tracks.length,
    };
  });
}

async function resolveSpotifyPlaybackUri(query: string): Promise<string> {
  const direct = spotifyUriFromInput(query);
  if (direct) return direct;
  const params = new URLSearchParams({ q: query.trim(), type: "track", limit: "1" });
  const result = await spotifyApi<{ tracks?: { items?: Array<{ uri?: string; name?: string; artists?: Array<{ name: string }> }> } }>(`/search?${params}`);
  const item = result?.tracks?.items?.[0];
  if (!item?.uri) throw new Error("Spotify 找不到這首歌，請改貼 Spotify 歌曲連結");
  return item.uri;
}

export async function controlSpotify(input: { command?: string; value?: number; deviceId?: string; query?: string }): Promise<{ ok: boolean; message: string }> {
  const device = input.deviceId ? `?device_id=${encodeURIComponent(input.deviceId)}` : "";
  const command = input.command;
  try {
    if (command === "play") {
      const query = input.query?.trim();
      if (!query) throw new Error("請輸入歌曲名稱或 Spotify 連結");
      const uri = await resolveSpotifyPlaybackUri(query);
      const isTrack = uri.startsWith("spotify:track:");
      await spotifyApi("/me/player/play" + device, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isTrack ? { uris: [uri] } : { context_uri: uri }),
      });
      return { ok: true, message: "已在 Spotify 開始播放" };
    }
    if (command === "previous") await spotifyApi("/me/player/previous" + device, { method: "POST" });
    else if (command === "next") await spotifyApi("/me/player/next" + device, { method: "POST" });
    else if (command === "pause") await spotifyApi("/me/player/pause" + device, { method: "PUT" });
    else if (command === "resume") await spotifyApi("/me/player/play" + device, { method: "PUT" });
    else if (command === "volume") {
      const volume = Math.max(0, Math.min(100, Math.round(input.value ?? 50)));
      const query = new URLSearchParams({ volume_percent: String(volume) });
      if (input.deviceId) query.set("device_id", input.deviceId);
      await spotifyApi(`/me/player/volume?${query}`, { method: "PUT" });
    } else if (command === "transfer" && input.deviceId) {
      await spotifyApi("/me/player", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_ids: [input.deviceId], play: false }),
      });
    } else return { ok: false, message: "不支援的 Spotify 控制" };
    return { ok: true, message: "Spotify 已更新" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function disconnectSpotify(): void {
  accessToken = "";
  accessTokenExpiresAt = 0;
  lastAuthError = "";
  saveChannelsSettings({ spotify: { enabled: false, refreshToken: "", accountName: "" } });
}
