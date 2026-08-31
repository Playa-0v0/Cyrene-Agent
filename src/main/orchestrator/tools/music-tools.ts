// music-tools.ts — M4 rewrite: CITA removed, 15 tools, encryptedId direct.
//
// Changes from M3:
// - Removed: ContextRefRegistry, issueSelectionContext, presentAndPublish,
//   MusicCandidateRefPayload, MusicSetRefPayload, music_present_tracks
// - music_search: no purpose param, returns tracks with encryptedId + originalId
// - music_play_track: accepts encryptedId (32-hex) or local-<hash> cache id,
//   calls playTrackFromUi (cache-first dispatch)
// - Added: music_toggle_favorite, music_remove_from_playlist (online playlist mgmt)
// - Added: music_get_cached_tracks, music_remove_cached_track (local cache pool)
// - Added: music_get_playback_status, music_stop_playback (player state/control, 0 quota)
import type { MusicService } from "../../music/music-service";
import type { ToolDefinition } from "../tool-registry";
import type { ToolContext } from "../tool-context";

const HEX32 = /^[0-9A-Fa-f]{32}$/;
/** 播放/缓存池曲目 ID：网易云 32-hex 加密 ID，或本地导入的 `local-<hash12>`。 */
const TRACK_ID_RE = /^([0-9A-Fa-f]{32}|local-[0-9a-f]{12})$/;

function conversationIdOf(ctx?: ToolContext): string {
  return ctx?.conversationId || "default";
}

export function buildMusicTools(service: MusicService): ToolDefinition[] {
  return [
    {
      id: "music_get_daily_recommendations",
      capability: "music.daily_recommendations",
      name: "获取今日推荐歌曲",
      description: "获取网易云音乐今日推荐歌曲。返回包含加密 ID 和原始 ID 的歌曲列表。需要用户已登录。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: true,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (_args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const set = service.getLatestSelectionSet(conversationId, "daily_recommendation")
          ?? await service.getDailyRecommendations(conversationId);
        return JSON.stringify({
          kind: "recommendations",
          tracks: set.tracks.map((t) => ({
            encryptedId: t.encryptedId ?? t.id,
            originalId: t.originalId,
            name: t.name,
            artists: t.artists,
            album: t.album,
            durationMs: t.durationMs,
            coverUrl: t.coverUrl,
          })),
        });
      },
    },
    {
      id: "music_search",
      capability: "music.search",
      name: "搜索网易云歌曲",
      description: "按关键词搜索网易云音乐。返回包含加密 ID 和原始 ID 的歌曲列表。用户说「播放某歌」时，先用此工具搜索拿到 encryptedId，再调 music_play_track。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "搜索关键词 (1-100 字)" },
          limit: { type: "number", description: "返回数量 (1-20)" },
        },
        required: ["keyword"],
      },
      needsContext: true,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const set = await service.searchTracks(
          String(args.keyword ?? ""),
          conversationId,
          args.limit as number | undefined,
        );
        return JSON.stringify({
          kind: "search",
          tracks: set.tracks.map((t) => ({
            encryptedId: t.encryptedId ?? t.id,
            originalId: t.originalId,
            name: t.name,
            artists: t.artists,
            album: t.album,
            durationMs: t.durationMs,
            coverUrl: t.coverUrl,
          })),
        });
      },
    },
    {
      id: "music_play_track",
      capability: "music.play_track",
      name: "播放歌曲",
      description: "播放一首歌曲。入参 encryptedId 从 music_search / music_get_daily_recommendations / music_get_cached_tracks 返回结果中获取（32 位十六进制加密 ID 或 local- 开头的本地缓存 ID）。已缓存的歌直接播本地文件，不消耗 API 配额。dispatched 表示已向 mpv 发送播放指令。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          encryptedId: { type: "string", description: "歌曲 ID：32 位十六进制加密 ID 或 local- 开头的缓存 ID" },
        },
        required: ["encryptedId"],
      },
      controlledInput: { encryptedId: "tool_result" },
      needsContext: false,
      effectKind: "external_side_effect" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const encryptedId = String(args.encryptedId ?? "");
        if (!TRACK_ID_RE.test(encryptedId)) {
          throw new Error("E_INVALID_ENCRYPTED_ID");
        }
        const dispatch = await service.playTrackFromUi(encryptedId);
        return JSON.stringify({ kind: "playback", dispatch });
      },
    },
    {
      id: "music_play_playlist",
      capability: "music.play_playlist",
      name: "播放网易云歌单",
      description: "播放指定的网易云音乐歌单。入参 playlistId 从 music_my_playlists 或 music_playlist_detail 返回结果中获取。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: { playlistId: { type: "string" } },
        required: ["playlistId"],
      },
      controlledInput: { playlistId: "tool_result" },
      effectKind: "external_side_effect" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const dispatch = await service.playPlaylist(String(args.playlistId));
        return JSON.stringify({ kind: "playback", dispatch });
      },
    },
    {
      id: "music_get_playback_status",
      capability: "music.playback_status",
      name: "获取当前播放状态",
      description: "查询当前播放状态：正在播放还是暂停、当前曲目（歌名/歌手）、播放进度、音量。回答「现在在放什么」「播到哪了」这类问题用此工具。不消耗 API 配额，不要求登录；没在播放时 track 为 null。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: false,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async () => {
        const s = service.getPlaybackState();
        return JSON.stringify({
          kind: "playback_status",
          connected: s.connected,
          isPlaying: s.loaded && !s.paused,
          paused: s.loaded && s.paused,
          track: s.track
            ? {
                encryptedId: s.track.encryptedId,
                name: s.track.name,
                artists: s.track.artists,
                coverUrl: s.track.coverUrl,
              }
            : null,
          positionMs: Math.round(s.position * 1000),
          durationMs: Math.round(s.duration * 1000),
          volume: s.volume,
        });
      },
    },
    {
      id: "music_stop_playback",
      capability: "music.stop_playback",
      name: "停止播放",
      description: "停止当前播放并清空已加载的曲目（播放器回到空闲状态）。不影响歌单、缓存等任何数据。当前没有播放时返回 stopped: false。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "input-control",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: false,
      effectKind: "external_side_effect" as const,
      verificationPolicy: "none" as const,
      execute: async () => {
        const state = service.getPlaybackState();
        if (!state.connected || !state.loaded) {
          return JSON.stringify({ kind: "stop_playback", stopped: false, nothingPlaying: true });
        }
        await service.playbackStop();
        return JSON.stringify({ kind: "stop_playback", stopped: true });
      },
    },
    {
      id: "music_my_playlists",
      capability: "music.my_playlists",
      name: "获取我的网易云歌单",
      description: "获取当前登录用户的网易云音乐歌单列表，包括创建的和收藏的歌单。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: false,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async () => {
        const playlists = await service.getMyPlaylists();
        return JSON.stringify({ kind: "my_playlists", playlists });
      },
    },
    {
      id: "music_playlist_detail",
      capability: "music.playlist_detail",
      name: "获取网易云歌单详情",
      description: "获取指定网易云音乐歌单的详细信息，包括歌单名称和其中的歌曲列表。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          playlistId: { type: "string", description: "网易云音乐歌单 ID" },
        },
        required: ["playlistId"],
      },
      controlledInput: { playlistId: "tool_result" },
      needsContext: false,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const detail = await service.getPlaylistDetail(String(args.playlistId));
        return JSON.stringify({ kind: "playlist_detail", detail });
      },
    },
    {
      id: "music_create_playlist",
      capability: "music.create_playlist",
      name: "创建网易云歌单",
      description: "为当前登录用户创建一个新的网易云音乐歌单。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "新歌单名称 (1-100 字)" },
          privacy: { type: "boolean", description: "是否为隐私歌单，默认否" },
        },
        required: ["name"],
      },
      needsContext: false,
      effectKind: "mutation" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const playlist = await service.createPlaylist(String(args.name), { privacy: Boolean(args.privacy) });
        return JSON.stringify({ kind: "create_playlist", playlist });
      },
    },
    {
      id: "music_add_to_playlist",
      capability: "music.add_to_playlist",
      name: "添加歌曲到网易云歌单",
      description: "将一首或多首歌曲添加到指定的网易云音乐歌单。trackIds 为 32 位十六进制加密歌曲 ID。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          playlistId: { type: "string", description: "目标歌单 ID" },
          trackIds: { type: "array", items: { type: "string" }, description: "要添加的加密歌曲 ID 列表 (32 位 hex)" },
        },
        required: ["playlistId", "trackIds"],
      },
      controlledInput: { playlistId: "tool_result" },
      needsContext: false,
      effectKind: "mutation" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const playlistId = String(args.playlistId ?? "");
        const trackIds = Array.isArray(args.trackIds) ? args.trackIds.map(String) : [];
        const result = await service.addToPlaylist(playlistId, trackIds);
        return JSON.stringify({ kind: "add_to_playlist", ...result });
      },
    },
    {
      id: "music_toggle_favorite",
      capability: "music.toggle_favorite",
      name: "红心收藏歌曲",
      description: "收藏（红心）或取消收藏一首网易云音乐歌曲。encryptedId 从 music_search / music_get_daily_recommendations 等工具结果中获取。favorite 为 true 表示收藏，false 表示取消收藏。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          encryptedId: { type: "string", description: "32 位十六进制加密歌曲 ID" },
          favorite: { type: "boolean", description: "true 收藏 / false 取消收藏" },
        },
        required: ["encryptedId", "favorite"],
      },
      controlledInput: { encryptedId: "tool_result" },
      needsContext: false,
      effectKind: "mutation" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const encryptedId = String(args.encryptedId ?? "");
        if (!HEX32.test(encryptedId)) {
          throw new Error("E_INVALID_ENCRYPTED_ID");
        }
        const favorite = args.favorite === true;
        await service.toggleFavorite(encryptedId, favorite);
        return JSON.stringify({ kind: "toggle_favorite", encryptedId, favorite });
      },
    },
    {
      id: "music_remove_from_playlist",
      capability: "music.remove_from_playlist",
      name: "从网易云歌单删除歌曲",
      description: "将一首或多首歌曲从指定的网易云音乐歌单中移除。playlistId 从 music_my_playlists 结果获取，trackIds 从 music_playlist_detail 结果获取。此操作不可在云端撤销，确认用户意图后再调用。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          playlistId: { type: "string", description: "目标歌单 ID" },
          trackIds: { type: "array", items: { type: "string" }, description: "要移除的加密歌曲 ID 列表 (32 位 hex)" },
        },
        required: ["playlistId", "trackIds"],
      },
      controlledInput: { playlistId: "tool_result", trackIds: "tool_result" },
      needsContext: false,
      effectKind: "mutation" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const playlistId = String(args.playlistId ?? "");
        const trackIds = Array.isArray(args.trackIds) ? args.trackIds.map(String) : [];
        const result = await service.removeFromPlaylist(playlistId, trackIds);
        return JSON.stringify({ kind: "remove_from_playlist", ...result });
      },
    },
    {
      id: "music_my_subscriptions",
      capability: "music.my_subscriptions",
      name: "获取我的网易云收藏",
      description: "获取当前登录用户收藏的歌手或专辑列表。category 为 'artists' 或 'albums'。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["artists", "albums"],
            description: "收藏类型：artists 表示歌手，albums 表示专辑",
          },
        },
        required: ["category"],
      },
      needsContext: false,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const category = String(args.category ?? "");
        if (category !== "artists" && category !== "albums") {
          throw new Error("E_INVALID_SUBSCRIPTION_CATEGORY");
        }
        const subscriptions = await service.getMySubscriptions(category as "artists" | "albums");
        return JSON.stringify({ kind: "my_subscriptions", category, subscriptions });
      },
    },
    {
      id: "music_get_cached_tracks",
      capability: "music.cached_tracks",
      name: "获取本地缓存歌单",
      description: "获取本地缓存歌单中的所有歌曲（边播边存下来的 + 用户导入的本地音乐）。不消耗 API 配额，不要求登录。source 字段区分来源：netease 为网易云缓存，imported 为用户导入。播放用 music_play_track（传 encryptedId），删除用 music_remove_cached_track。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: false,
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async () => {
        const tracks = await service.getCachedTracks();
        return JSON.stringify({
          kind: "cached_tracks",
          tracks: tracks.map((t) => ({
            encryptedId: t.encryptedId ?? t.id,
            name: t.name,
            artists: t.artists,
            album: t.album,
            durationMs: t.durationMs,
            coverUrl: t.coverUrl,
            source: t.source,
          })),
        });
      },
    },
    {
      id: "music_remove_cached_track",
      capability: "music.remove_cached_track",
      name: "删除本地缓存歌曲",
      description: "从本地缓存歌单中删除一首歌（删除缓存文件，不影响网易云云端数据）。trackId 从 music_get_cached_tracks 结果中获取。正在播放的歌无法删除（会报 E_CACHE_TRACK_PLAYING）。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          trackId: { type: "string", description: "缓存歌曲 ID：32 位 hex 或 local- 开头" },
        },
        required: ["trackId"],
      },
      controlledInput: { trackId: "tool_result" },
      needsContext: false,
      effectKind: "mutation" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const trackId = String(args.trackId ?? "");
        if (!TRACK_ID_RE.test(trackId)) {
          throw new Error("E_INVALID_ENCRYPTED_ID");
        }
        const removed = await service.removeCachedTrack(trackId);
        return JSON.stringify({ kind: "remove_cached_track", trackId, removed });
      },
    },
  ];
}
