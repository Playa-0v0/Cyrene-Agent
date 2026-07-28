import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { toTraditionalTaiwan } from "../../../utils/opencc";

// 足以涵蓋 Bilibili 跨作品音樂合集，同時避免無界清單耗盡記憶體。
const MAX_PLAYLIST_ITEMS = 500;
const MUSIC_STARTUP_BUFFER_BYTES = 384 * 1024;
const MUSIC_BUFFER_CAPACITY_BYTES = 2 * 1024 * 1024;
const MUSIC_BUFFER_TIMEOUT_MS = 12_000;
const YT_DLP_RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const SUPPORTED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "bilibili.com",
  "www.bilibili.com",
  "m.bilibili.com",
  "b23.tv",
  "soundcloud.com",
  "www.soundcloud.com",
  "open.spotify.com",
  "spotify.link",
]);

export interface DiscordMusicTrack {
  id?: string;
  title: string;
  url: string;
  /** 實際交給 yt-dlp 的音源；Spotify 等來源保留 url 作為署名連結。 */
  playbackUrl?: string;
  thumbnail?: string;
  playlistTitle?: string;
  playlistUrl?: string;
  duration?: number;
  index: number;
  total: number;
}

export type DiscordMusicProcess = ChildProcessByStdio<null, Readable, Readable> & {
  /** 預先緩衝後交給 Discord 解碼器的音訊流；舊測試替身可省略。 */
  audio?: Readable;
  waitForBuffer?: () => Promise<number>;
};

export type DiscordMusicCommand =
  | "previous"
  | "pause"
  | "resume"
  | "skip"
  | "stop"
  | "queue"
  | "repeat-track"
  | "repeat-queue"
  | "repeat-off"
  | "shuffle"
  | "ordered"
  | "clear"
  | "remove"
  | "volume"
  | "refresh"
  | "autoplay-on"
  | "autoplay-off"
  | "history"
  | "favorite"
  | "favorites";

export interface DiscordMusicRequest {
  url?: string;
  command?: DiscordMusicCommand;
  value?: number;
}

interface YtDlpEntry {
  id?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  original_url?: string;
  duration?: number;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string } | null>;
}

interface YtDlpResult extends YtDlpEntry {
  entries?: Array<YtDlpEntry | null>;
  playlist_count?: number;
}

interface BilibiliSeasonEpisode {
  title?: string;
  bvid?: string;
  arc?: { duration?: number; pic?: string };
}

interface BilibiliInitialState {
  videoData?: {
    ugc_season?: {
      title?: string;
      cover?: string;
      sections?: Array<{ episodes?: BilibiliSeasonEpisode[] }>;
    };
  };
}

interface BilibiliViewPayload {
  code?: number;
  data?: {
    bvid?: string;
    title?: string;
    pic?: string;
    pages?: Array<{
      page?: number;
      part?: string;
      duration?: number;
      first_frame?: string;
    }>;
  };
}

let ytDlpBinaryPromise: Promise<string> | null = null;
let bilibiliBrowserCookieSpec: string | null = null;

export function getOperaGxProfilePath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "com.operasoftware.OperaGX", "Default");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Opera Software", "Opera GX Stable");
  }
  return path.join(os.homedir(), ".config", "opera-gx", "Default");
}

export function configureBilibiliBrowserCookies(enabled: boolean): void {
  bilibiliBrowserCookieSpec = enabled ? `opera:${getOperaGxProfilePath()}` : null;
}

export function bilibiliCookieArgs(source: string): string[] {
  if (!bilibiliBrowserCookieSpec || !/(?:bilibili\.com|b23\.tv)/i.test(source)) return [];
  return ["--cookies-from-browser", bilibiliBrowserCookieSpec];
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export function findDiscordMusicUrl(text: string): string | undefined {
  for (const match of text.matchAll(/https?:\/\/[^\s<>]+/gi)) {
    const candidate = match[0].replace(/[，。！？、；：)\]}>'\"]+$/g, "");
    try {
      const url = new URL(candidate);
      if (SUPPORTED_HOSTS.has(normalizeHost(url.hostname))) return url.toString();
    } catch {
      // Ignore malformed links and let the message continue through normal AI handling.
    }
  }
  return undefined;
}

export function parseDiscordMusicRequest(text: string): DiscordMusicRequest | null {
  const url = findDiscordMusicUrl(text);
  if (url) return { url };

  const normalized = text.trim().replace(/[！!。.，,？?]/g, "").replace(/\s+/g, "");
  if (/^(暫停|暫停音樂|暫停播放)$/.test(normalized)) return { command: "pause" };
  if (/^(繼續|繼續音樂|繼續播放|恢復播放)$/.test(normalized)) return { command: "resume" };
  if (/^(下一首|跳過|跳過這首|切歌)$/.test(normalized)) return { command: "skip" };
  if (/^(停止音樂|停止播放|關掉音樂|結束播放)$/.test(normalized)) return { command: "stop" };
  if (/^(播放清單|播放列表|目前歌單|目前佇列|歌單|佇列)$/.test(normalized)) return { command: "queue" };
  if (/^(單曲循環|單曲重複)$/.test(normalized)) return { command: "repeat-track" };
  if (/^(列表循環|清單循環|歌單循環)$/.test(normalized)) return { command: "repeat-queue" };
  if (/^(關閉循環|取消循環|不循環)$/.test(normalized)) return { command: "repeat-off" };
  if (/^(隨機播放|打亂播放)$/.test(normalized)) return { command: "shuffle" };
  if (/^(順序播放|取消隨機)$/.test(normalized)) return { command: "ordered" };
  if (/^(清空歌單|清空佇列|清除歌單)$/.test(normalized)) return { command: "clear" };
  const remove = normalized.match(/^(?:移除|刪除)(?:第)?(\d+)(?:首)?$/);
  if (remove) return { command: "remove", value: Number.parseInt(remove[1], 10) };
  const volume = normalized.match(/^音量(\d{1,3})$/);
  if (volume) return { command: "volume", value: Number.parseInt(volume[1], 10) };
  return null;
}

function requestedStartIndex(rawUrl: string): number {
  try {
    const url = new URL(rawUrl);
    const value = url.searchParams.get("index") ?? url.searchParams.get("p");
    const parsed = value ? Number.parseInt(value, 10) : 1;
    return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
  } catch {
    return 0;
  }
}

function entryUrl(entry: YtDlpEntry, fallback: string): string {
  const candidate = entry.webpage_url ?? entry.original_url ?? entry.url;
  if (!candidate) return fallback;
  if (/^https?:\/\//i.test(candidate)) return candidate;
  if (/^[\w-]{11}$/.test(candidate)) return `https://www.youtube.com/watch?v=${candidate}`;
  return fallback;
}

function entryThumbnail(entry: YtDlpEntry, fallback?: YtDlpEntry): string | undefined {
  const thumbnails = entry.thumbnails?.filter((item): item is { url?: string } => !!item)
    ?? fallback?.thumbnails?.filter((item): item is { url?: string } => !!item)
    ?? [];
  const candidate = entry.thumbnail ?? thumbnails.at(-1)?.url ?? fallback?.thumbnail;
  return candidate && /^https?:\/\//i.test(candidate) ? candidate : undefined;
}

/** A plain, copy-friendly source URL. Bilibili links are reduced to video id + part only. */
export function copyableDiscordMusicUrl(input: string): string | null {
  const extracted = findDiscordMusicUrl(input) ?? input.trim();
  try {
    const url = new URL(extracted);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (/^(?:www\.|m\.)?bilibili\.com$/i.test(url.hostname)) {
      const videoId = url.pathname.match(/\/video\/(BV[A-Za-z0-9]+)/i)?.[1];
      if (videoId) {
        const part = Number.parseInt(url.searchParams.get("p") ?? "1", 10);
        return `https://www.bilibili.com/video/${videoId}${part > 1 ? `?p=${part}` : ""}`;
      }
    }
    if (/^(?:www\.)?b23\.tv$/i.test(url.hostname)) {
      return `${url.protocol}//${url.host}${url.pathname}`;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function cleanDiscordMusicTrackTitle(title: string, playlistTitle?: string): string {
  const normalized = title.trim();
  const part = normalized.match(/\s+p\d{1,3}\s+(.+)$/i)?.[1]?.trim();
  if (part) return toTraditionalTaiwan(part);
  if (playlistTitle && normalized.startsWith(playlistTitle)) {
    const remainder = normalized.slice(playlistTitle.length).replace(/^\s*[-–—:：|]\s*/, "").trim();
    if (remainder) return toTraditionalTaiwan(remainder);
  }
  return toTraditionalTaiwan(normalized);
}

export function cleanDiscordMusicPlaylistTitle(title: string): string {
  return toTraditionalTaiwan(title
    .trim()
    .replace(/^【(?:音[乐樂]集|歌曲集|合集)】\s*/i, "")
    .replace(/\s*【[^】]*(?:Hi-?Res|完整版|中日(?:歌[词詞]|字幕)|無損|无损)[^】]*】\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim());
}

export function buildSpotifySearchQuery(title: string, description = ""): string {
  const artist = description.split("·")[0]?.trim();
  return [title.trim(), artist].filter(Boolean).join(" ");
}

interface SpotifyEmbedTrack {
  uri?: string;
  title?: string;
  subtitle?: string;
  duration?: number;
  isPlayable?: boolean;
}

interface SpotifyEmbedEntity extends SpotifyEmbedTrack {
  type?: string;
  name?: string;
  id?: string;
  coverArt?: { sources?: Array<{ url?: string }> };
  trackList?: SpotifyEmbedTrack[];
}

export function parseSpotifyEmbedHtml(html: string, playlistUrl?: string): DiscordMusicTrack[] {
  const raw = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!raw) return [];
  let entity: SpotifyEmbedEntity | undefined;
  try {
    const data = JSON.parse(raw) as { props?: { pageProps?: { state?: { data?: { entity?: SpotifyEmbedEntity } } } } };
    entity = data.props?.pageProps?.state?.data?.entity;
  } catch {
    return [];
  }
  if (!entity) return [];
  const rawTracks = entity.trackList?.length ? entity.trackList : [entity];
  const tracks = rawTracks.filter((track) => track.title && track.uri?.startsWith("spotify:track:"))
    .slice(0, MAX_PLAYLIST_ITEMS);
  const cover = entity.coverArt?.sources?.find((source) => source.url)?.url;
  const playlistTitle = tracks.length > 1 ? toTraditionalTaiwan(entity.title ?? entity.name ?? "Spotify 播放清單") : undefined;
  return tracks.map((track, index) => {
    const id = track.uri!.split(":").at(-1)!;
    const title = toTraditionalTaiwan(track.title!.trim());
    const artist = toTraditionalTaiwan(track.subtitle?.trim() ?? "");
    return {
      id,
      title: artist ? `${title} — ${artist}` : title,
      url: `https://open.spotify.com/track/${id}`,
      playbackUrl: `ytsearch1:${buildSpotifySearchQuery(title, artist)}`,
      thumbnail: cover,
      playlistTitle,
      playlistUrl: playlistTitle && playlistUrl ? playlistUrl : undefined,
      duration: typeof track.duration === "number" ? Math.round(track.duration / 1000) : undefined,
      index: index + 1,
      total: tracks.length,
    };
  });
}

async function resolveSpotifyReference(url: string): Promise<DiscordMusicTrack[]> {
  const page = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 CyreneDiscordBot/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!page.ok) throw new Error(`Spotify 連結讀取失敗（HTTP ${page.status}）`);
  const match = new URL(page.url).pathname.match(/^\/(track|album|playlist)\/([A-Za-z0-9]+)/i);
  if (!match) throw new Error("目前支援 Spotify 單曲、專輯與播放清單連結。");
  const embed = await fetch(`https://open.spotify.com/embed/${match[1]}/${match[2]}`, {
    headers: { "user-agent": "Mozilla/5.0 CyreneDiscordBot/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!embed.ok) throw new Error(`Spotify Embed 讀取失敗（HTTP ${embed.status}）`);
  const canonicalPlaylistUrl = match[1].toLowerCase() === "playlist"
    ? `https://open.spotify.com/playlist/${match[2]}`
    : undefined;
  const tracks = parseSpotifyEmbedHtml(await embed.text(), canonicalPlaylistUrl);
  if (!tracks.length) throw new Error("無法讀取這份 Spotify 清單；私人清單需要先在 Spotify 設為公開。 ");
  return tracks;
}

function cleanBilibiliEpisodeTitle(title: string): string {
  return toTraditionalTaiwan(title.trim().replace(/^[“”"「『]+|[“”"」』]+$/g, "").trim());
}

export function normalizeBilibiliPages(
  payload: BilibiliViewPayload,
  sourceUrl: string,
): DiscordMusicTrack[] {
  if (payload.code !== 0 || !payload.data?.bvid) return [];
  const pages = payload.data.pages?.slice(0, MAX_PLAYLIST_ITEMS) ?? [];
  if (pages.length <= 1) return [];
  const start = Math.min(requestedStartIndex(sourceUrl), pages.length - 1);
  const playlistTitle = cleanDiscordMusicPlaylistTitle(payload.data.title?.trim() || "Bilibili 分集播放");
  const fallbackThumbnail = payload.data.pic?.replace(/^http:\/\//i, "https://");
  return pages.slice(start).map((page, offset) => {
    const pageNumber = page.page ?? start + offset + 1;
    return {
      id: `${payload.data?.bvid}-p${pageNumber}`,
      title: cleanBilibiliEpisodeTitle(page.part || `第 ${pageNumber} 首`),
      url: `https://www.bilibili.com/video/${payload.data?.bvid}/?p=${pageNumber}`,
      thumbnail: page.first_frame?.replace(/^http:\/\//i, "https://") ?? fallbackThumbnail,
      playlistTitle,
      duration: page.duration,
      index: pageNumber,
      total: pages.length,
    };
  });
}

export function parseBilibiliSeasonHtml(html: string, sourceUrl: string): DiscordMusicTrack[] {
  const marker = "window.__INITIAL_STATE__=";
  const start = html.indexOf(marker);
  if (start < 0) return [];
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";(function()", jsonStart);
  if (jsonEnd < 0) return [];
  let state: BilibiliInitialState;
  try {
    state = JSON.parse(html.slice(jsonStart, jsonEnd)) as BilibiliInitialState;
  } catch {
    return [];
  }
  const season = state.videoData?.ugc_season;
  const episodes = season?.sections?.flatMap((section) => section.episodes ?? [])
    .filter((episode): episode is BilibiliSeasonEpisode & { bvid: string } => !!episode.bvid)
    .slice(0, MAX_PLAYLIST_ITEMS) ?? [];
  if (episodes.length < 2) return [];
  const currentBvid = new URL(sourceUrl).pathname.match(/\/video\/(BV[\w]+)/i)?.[1]?.toLowerCase();
  const currentIndex = Math.max(0, episodes.findIndex((episode) => episode.bvid.toLowerCase() === currentBvid));
  const playlistTitle = cleanDiscordMusicPlaylistTitle(season?.title?.trim() || "Bilibili 合集");
  return episodes.slice(currentIndex).map((episode, offset) => ({
    id: episode.bvid,
    title: cleanBilibiliEpisodeTitle(episode.title || `第 ${currentIndex + offset + 1} 集`),
    url: `https://www.bilibili.com/video/${episode.bvid}/`,
    thumbnail: episode.arc?.pic?.replace(/^http:\/\//i, "https://") ?? season?.cover,
    playlistTitle,
    duration: episode.arc?.duration,
    index: currentIndex + offset + 1,
    total: episodes.length,
  }));
}

async function resolveBilibiliSeason(url: string): Promise<DiscordMusicTrack[]> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 CyreneDiscordBot/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return [];
  const episodes = parseBilibiliSeasonHtml(await response.text(), response.url);
  if (episodes.length < 2) return [];
  const expanded = await Promise.all(episodes.map(async (episode) => {
    try {
      const api = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(episode.id ?? "")}`, {
        headers: { "user-agent": "Mozilla/5.0 CyreneDiscordBot/1.0", referer: "https://www.bilibili.com/" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!api.ok) return [episode];
      const payload = await api.json() as {
        code?: number;
        data?: { pages?: Array<{ page?: number; part?: string; duration?: number; first_frame?: string }> };
      };
      const pages = payload.code === 0 ? payload.data?.pages?.slice(0, MAX_PLAYLIST_ITEMS) ?? [] : [];
      if (pages.length <= 1) return [episode];
      const base = cleanDiscordMusicPlaylistTitle(episode.title)
        .replace(/\s*歌曲全收[录錄](?:[（(].*?[）)])?\s*$/i, "")
        .trim();
      const category = /音[乐樂]集$/i.test(base) ? base : `${base} 音樂集`;
      return pages.map((page, index) => ({
        id: `${episode.id}-p${page.page ?? index + 1}`,
        title: cleanBilibiliEpisodeTitle(page.part || `第 ${index + 1} 首`),
        url: `${episode.url}${episode.url.includes("?") ? "&" : "?"}p=${page.page ?? index + 1}`,
        thumbnail: page.first_frame?.replace(/^http:\/\//i, "https://") ?? episode.thumbnail,
        playlistTitle: category,
        duration: page.duration,
        index: index + 1,
        total: pages.length,
      }));
    } catch {
      return [episode];
    }
  }));
  const hasNestedCategory = expanded.some((tracks) => tracks.length > 1);
  if (!hasNestedCategory) return episodes;
  const requestedPart = requestedStartIndex(url);
  if (requestedPart > 0) expanded[0] = expanded[0].slice(Math.min(requestedPart, Math.max(0, expanded[0].length - 1)));
  return expanded.flat().slice(0, MAX_PLAYLIST_ITEMS);
}

async function resolveBilibiliPages(url: string): Promise<DiscordMusicTrack[]> {
  const page = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0 CyreneDiscordBot/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!page.ok) return [];
  // b23.tv 等短網址需要先跟隨重新導向，才能取得真正的 BV 編號。
  const bvid = page.url.match(/\/video\/(BV[\w]+)/i)?.[1];
  if (!bvid) return [];
  const api = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    headers: { "user-agent": "Mozilla/5.0 CyreneDiscordBot/1.0", referer: "https://www.bilibili.com/" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!api.ok) return [];
  return normalizeBilibiliPages(await api.json() as BilibiliViewPayload, page.url);
}

/**
 * Bilibili may expose the same video as both a UGC season and a multi-page
 * video.  The season payload is useful for category names, but it can contain
 * only the currently expanded category.  Never let that partial result
 * truncate the complete `pages` queue.
 */
export function selectBilibiliTracks(
  season: DiscordMusicTrack[],
  pages: DiscordMusicTrack[],
): DiscordMusicTrack[] {
  if (pages.length > season.length) {
    const seasonById = new Map(
      season
        .filter((track) => track.id)
        .map((track) => [track.id!.toLowerCase(), track] as const),
    );
    return pages.map((track) => {
      const category = track.id ? seasonById.get(track.id.toLowerCase()) : undefined;
      return category?.playlistTitle
        ? { ...track, playlistTitle: category.playlistTitle }
        : track;
    });
  }
  if (season.length > 1) return season;
  if (pages.length > 1) return pages;
  return season.length ? season : pages;
}

export function normalizeYtDlpResult(result: YtDlpResult, sourceUrl: string): DiscordMusicTrack[] {
  const rawEntries = result.entries?.filter((entry): entry is YtDlpEntry => !!entry) ?? [result];
  const start = Math.min(requestedStartIndex(sourceUrl), Math.max(0, rawEntries.length - 1));
  const entries = rawEntries.slice(start, start + MAX_PLAYLIST_ITEMS);
  const total = entries.length;
  const rawPlaylistTitle = result.title?.trim();
  const playlistTitle = rawPlaylistTitle ? cleanDiscordMusicPlaylistTitle(rawPlaylistTitle) : undefined;
  return entries.map((entry, offset) => {
    const index = start + offset + 1;
    const fallbackTitle = rawEntries.length > 1 ? `第 ${index} 首` : playlistTitle ?? "音樂";
    const rawTitle = entry.title?.trim() || fallbackTitle;
    return {
      id: entry.id,
      title: cleanDiscordMusicTrackTitle(rawTitle, rawPlaylistTitle),
      url: entryUrl(entry, sourceUrl),
      thumbnail: entryThumbnail(entry, result),
      playlistTitle: rawEntries.length > 1 ? playlistTitle : undefined,
      duration: typeof entry.duration === "number" ? entry.duration : undefined,
      index,
      total: result.playlist_count ?? rawEntries.length,
    };
  });
}

export async function resolveDiscordMusicTracks(input: string): Promise<DiscordMusicTrack[]> {
  const trimmed = input.trim();
  // Bilibili's share action prefixes the URL with 【video title】. Slash command
  // options may therefore contain prose plus a valid link; always canonicalize it.
  let sourceUrl = findDiscordMusicUrl(trimmed) ?? trimmed;
  let sourceHost = "";
  try {
    const parsed = new URL(sourceUrl);
    sourceHost = parsed.hostname;
  } catch {
    // /play 明確表示音樂請求；不是網址時交給 yt-dlp 搜尋第一個結果。
    sourceUrl = `ytsearch1:${trimmed}`;
  }
  if (!trimmed) throw new Error("請輸入歌曲名稱或音樂連結。");
  const isBilibili = /(^|\.)bilibili\.com$|^b23\.tv$/i.test(sourceHost);
  const isSpotify = /^open\.spotify\.com$|^spotify\.link$/i.test(sourceHost);
  if (isSpotify) return await resolveSpotifyReference(sourceUrl);
  if (isBilibili) {
    const [season, pages] = await Promise.all([
      resolveBilibiliSeason(sourceUrl).catch((err) => {
        console.warn("[DiscordMusicSource] Bilibili 合集解析失敗，改用其他解析結果:", err instanceof Error ? err.message : err);
        return [];
      }),
      resolveBilibiliPages(sourceUrl).catch((err) => {
        console.warn("[DiscordMusicSource] Bilibili 分集解析失敗，改用其他解析結果:", err instanceof Error ? err.message : err);
        return [];
      }),
    ]);
    const bilibiliTracks = selectBilibiliTracks(season, pages);
    if (bilibiliTracks.length > 1) return bilibiliTracks;
  }
  const binary = await ensureYtDlpBinary();
  const commonArgs = [
    ...bilibiliCookieArgs(sourceUrl),
    "--dump-single-json",
    "--no-warnings",
    "--no-progress",
    "--playlist-end",
    String(MAX_PLAYLIST_ITEMS),
    "--skip-download",
    "--yes-playlist",
  ];
  let result = await runYtDlpJson(binary, [
    ...commonArgs,
    "--flat-playlist",
    sourceUrl,
  ]);
  const entries = result.entries?.filter((entry): entry is YtDlpEntry => !!entry) ?? [];
  if (isBilibili && entries.length > 1 && entries.length <= 30 && entries.some((entry) => !entry.title)) {
    result = await runYtDlpJson(binary, [...commonArgs, sourceUrl]);
  } else if (isBilibili && !entryThumbnail(entries[0] ?? result, result)) {
    const details = await runYtDlpJson(binary, [
      ...commonArgs,
      "--playlist-end",
      "1",
      sourceUrl,
    ]);
    const detailedEntry = details.entries?.find((entry): entry is YtDlpEntry => !!entry) ?? details;
    const thumbnail = entryThumbnail(detailedEntry, details);
    if (entries.length > 1) result.thumbnail = thumbnail;
    else result = details;
  }

  // flat-playlist 對部分 YouTube／SoundCloud 項目不會附時長或封面；
  // 補抓第一首的完整 metadata，避免明明是一般歌曲卻在播放器顯示 LIVE。
  const first = result.entries?.find((entry): entry is YtDlpEntry => !!entry) ?? result;
  if (typeof first.duration !== "number" || !entryThumbnail(first, result)) {
    const detailUrl = entryUrl(first, sourceUrl);
    const details = await runYtDlpJson(binary, [
      ...commonArgs,
      "--no-playlist",
      detailUrl,
    ]).catch(() => null);
    if (details) {
      const detailedEntry = details.entries?.find((entry): entry is YtDlpEntry => !!entry) ?? details;
      Object.assign(first, {
        duration: detailedEntry.duration ?? first.duration,
        thumbnail: entryThumbnail(detailedEntry, details) ?? first.thumbnail,
        webpage_url: detailedEntry.webpage_url ?? first.webpage_url,
      });
    }
  }
  return normalizeYtDlpResult(result, sourceUrl);
}

export async function searchDiscordMusicTracks(query: string, limit = 5): Promise<DiscordMusicTrack[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const safeLimit = Math.max(1, Math.min(10, Math.floor(limit)));
  const binary = await ensureYtDlpBinary();
  const result = await runYtDlpJson(binary, [
    "--dump-single-json",
    "--no-warnings",
    "--no-progress",
    "--skip-download",
    "--flat-playlist",
    `ytsearch${safeLimit}:${trimmed}`,
  ]);
  return normalizeYtDlpResult(result, `ytsearch${safeLimit}:${trimmed}`)
    .slice(0, safeLimit)
    .map((track, index, tracks) => ({ ...track, playlistTitle: undefined, index: index + 1, total: tracks.length }));
}

function ytDlpAsset(): { asset: string; binary: string; archive: boolean } {
  if (process.platform === "darwin") return { asset: "yt-dlp_macos.zip", binary: "yt-dlp_macos", archive: true };
  if (process.platform === "win32") {
    const binary = process.arch === "arm64" ? "yt-dlp_arm64.exe" : "yt-dlp.exe";
    return { asset: binary, binary, archive: false };
  }
  if (process.platform === "linux") {
    const binary = process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
    return { asset: binary, binary, archive: false };
  }
  throw new Error(`目前不支援 ${process.platform}/${process.arch} 的音樂播放工具`);
}

function ytDlpCacheDirectory(): string {
  try {
    const electron = require("electron") as { app?: { getPath(name: "userData"): string } };
    const userData = electron.app?.getPath("userData");
    if (userData) return path.join(userData, "tools");
  } catch {
    // Unit tests and non-Electron utilities use a project-local cache.
  }
  return path.join(process.cwd(), ".cyrene-cache", "tools");
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`下載失敗（HTTP ${response.status}）`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadVerifiedYtDlp(asset: string): Promise<Buffer> {
  const [binary, checksums] = await Promise.all([
    fetchBuffer(`${YT_DLP_RELEASE_BASE}/${asset}`),
    fetchBuffer(`${YT_DLP_RELEASE_BASE}/SHA2-256SUMS`),
  ]);
  const checksumLine = checksums.toString("utf8").split(/\r?\n/)
    .find((line) => line.trim().endsWith(asset));
  const expected = checksumLine?.trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash("sha256").update(binary).digest("hex");
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
    throw new Error("yt-dlp 官方檔案驗證失敗，已取消安裝");
  }
  return binary;
}

async function runTool(command: string, args: string[], timeout: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const process = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => process.kill("SIGKILL"), timeout);
    process.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    process.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    process.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} 結束代碼 ${code}`));
    });
  });
}

async function installYtDlp(cacheDirectory: string, definition: ReturnType<typeof ytDlpAsset>): Promise<string> {
  await fs.mkdir(cacheDirectory, { recursive: true });
  const contents = await downloadVerifiedYtDlp(definition.asset);
  if (!definition.archive) {
    const binaryPath = path.join(cacheDirectory, definition.binary);
    const temporary = `${binaryPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, contents, { mode: 0o755 });
    await fs.chmod(temporary, 0o755);
    await fs.rename(temporary, binaryPath);
    return binaryPath;
  }

  const targetDirectory = path.join(cacheDirectory, "yt-dlp_macos-unpacked");
  const temporaryDirectory = `${targetDirectory}.${process.pid}.tmp`;
  const archivePath = path.join(cacheDirectory, `.${definition.asset}.${process.pid}.tmp`);
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  await fs.writeFile(archivePath, contents);
  try {
    await fs.mkdir(temporaryDirectory, { recursive: true });
    await runTool("/usr/bin/ditto", ["-x", "-k", archivePath, temporaryDirectory], 120_000);
    const temporaryBinary = path.join(temporaryDirectory, definition.binary);
    await fs.chmod(temporaryBinary, 0o755);
    await fs.rm(targetDirectory, { recursive: true, force: true });
    await fs.rename(temporaryDirectory, targetDirectory);
    return path.join(targetDirectory, definition.binary);
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function ensureYtDlpBinary(): Promise<string> {
  if (ytDlpBinaryPromise) return await ytDlpBinaryPromise;
  ytDlpBinaryPromise = (async () => {
    const definition = ytDlpAsset();
    const cacheDirectory = ytDlpCacheDirectory();
    const binaryPath = definition.archive
      ? path.join(cacheDirectory, "yt-dlp_macos-unpacked", definition.binary)
      : path.join(cacheDirectory, definition.binary);
    try {
      await fs.access(binaryPath, fsConstants.X_OK);
      return binaryPath;
    } catch {
      return await installYtDlp(cacheDirectory, definition);
    }
  })();
  try {
    return await ytDlpBinaryPromise;
  } catch (err) {
    ytDlpBinaryPromise = null;
    throw err;
  }
}

async function runYtDlpJson(binary: string, args: string[]): Promise<YtDlpResult> {
  return await new Promise<YtDlpResult>((resolve, reject) => {
    const process = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => process.kill("SIGKILL"), 45_000);
    process.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    process.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    process.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    process.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `yt-dlp 結束代碼 ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as YtDlpResult);
      } catch {
        reject(new Error("無法解析播放清單資料"));
      }
    });
  });
}

export function discordMusicSeekArgs(startAtSeconds = 0): string[] {
  const seconds = Math.max(0, Math.floor(startAtSeconds));
  if (!seconds) return [];
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const timestamp = [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
  return ["--download-sections", `*${timestamp}-inf`, "--force-keyframes-at-cuts"];
}

export function discordMusicStreamArgs(source: string, startAtSeconds = 0): string[] {
  return [
    ...bilibiliCookieArgs(source),
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--retries", "5",
    "--fragment-retries", "5",
    "--retry-sleep", "1",
    "--socket-timeout", "20",
    "--format", "bestaudio/best",
    ...discordMusicSeekArgs(startAtSeconds),
    "--output", "-",
    source,
  ];
}

export function attachDiscordMusicBuffer(process: ChildProcessByStdio<null, Readable, Readable>): DiscordMusicProcess {
  const audio = new PassThrough({
    readableHighWaterMark: MUSIC_BUFFER_CAPACITY_BYTES,
    writableHighWaterMark: MUSIC_BUFFER_CAPACITY_BYTES,
  });
  let receivedBytes = 0;
  process.stdout.on("data", (chunk: Buffer) => { receivedBytes += chunk.length; });
  process.stdout.pipe(audio);

  const waitForBuffer = async (): Promise<number> => {
    if (receivedBytes >= MUSIC_STARTUP_BUFFER_BYTES || process.stdout.readableEnded) return receivedBytes;
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.stdout.off("data", onData);
        process.stdout.off("end", onEnd);
        process.stdout.off("error", onError);
        if (error && receivedBytes === 0) reject(error);
        else resolve(receivedBytes);
      };
      const onData = () => {
        if (receivedBytes >= MUSIC_STARTUP_BUFFER_BYTES) finish();
      };
      const onEnd = () => finish();
      const onError = (error: Error) => finish(error);
      const timer = setTimeout(
        () => finish(new Error("音訊來源在緩衝時間內沒有傳回資料")),
        MUSIC_BUFFER_TIMEOUT_MS,
      );
      process.stdout.on("data", onData);
      process.stdout.once("end", onEnd);
      process.stdout.once("error", onError);
      onData();
    });
  };

  return Object.assign(process, { audio, waitForBuffer });
}

export async function spawnDiscordMusicStream(track: DiscordMusicTrack, startAtSeconds = 0): Promise<DiscordMusicProcess> {
  const binary = await ensureYtDlpBinary();
  const source = track.playbackUrl ?? track.url;
  const process = spawn(binary, discordMusicStreamArgs(source, startAtSeconds), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return attachDiscordMusicBuffer(process);
}

export async function testBilibiliBrowserCookies(): Promise<{ profilePath: string; title: string }> {
  const profilePath = getOperaGxProfilePath();
  await fs.access(path.join(profilePath, "Cookies"), fsConstants.R_OK);
  const binary = await ensureYtDlpBinary();
  const result = await runYtDlpJson(binary, [
    "--cookies-from-browser",
    `opera:${profilePath}`,
    "--dump-single-json",
    "--no-warnings",
    "--no-progress",
    "--skip-download",
    "--no-playlist",
    "https://www.bilibili.com/video/BV1EArsYVESc?p=2",
  ]);
  return { profilePath, title: toTraditionalTaiwan(result.title?.trim() || "Bilibili 登入狀態可用") };
}

export function formatMusicDuration(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = String(rounded % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}
