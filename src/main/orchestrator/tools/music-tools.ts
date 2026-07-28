import { randomUUID } from "crypto";
import type { ContextEvent } from "../../cita";
import type { MusicService } from "../../music/music-service";
import type {
  MusicCandidateRefPayload,
  MusicSelectionSet,
  MusicSetRefPayload,
  MusicTrack,
} from "../../music/types";
import { ContextRefRegistry } from "../context-ref-registry";
import { contextRefRegistry, type ToolContext } from "../tool-context";
import type { ToolDefinition } from "../tool-registry";
import type { SoulProjectionConfig } from "../soul-execution-context";

export interface MusicToolHooks {
  contextRefs?: ContextRefRegistry;
  ingestContextEvent?: (event: ContextEvent) => void;
  sendCard?: (card: {
    setId: string;
    source: string;
    tracks: MusicTrack[];
  }) => boolean;
}

interface SafeMusicContext {
  setRef: string;
  source: MusicSelectionSet["source"];
  candidates: Array<{
    candidateRef: string;
    position: number;
    name: string;
    artists: string[];
    album?: string;
  }>;
}

function conversationIdOf(ctx?: ToolContext): string {
  return ctx?.conversationId || "default";
}

function refsOf(ctx: ToolContext | undefined, hooks: MusicToolHooks): ContextRefRegistry {
  return ctx?.contextRefs ?? hooks.contextRefs ?? contextRefRegistry;
}

function publishEvent(hooks: MusicToolHooks, event: ContextEvent): void {
  hooks.ingestContextEvent?.(event);
}

function issueSelectionContext(
  set: MusicSelectionSet,
  refs: ContextRefRegistry,
  hooks: MusicToolHooks,
): SafeMusicContext {
  const setRef = refs.issue<MusicSetRefPayload>({
    conversationId: set.conversationId,
    domain: "music",
    kind: "selection_set",
    expiresAt: set.expiresAt,
    value: { provider: set.provider, setId: set.setId, conversationId: set.conversationId },
  });
  publishEvent(hooks, {
    type: "context_upserted",
    eventId: randomUUID(),
    conversationId: set.conversationId,
    occurredAt: Date.now(),
    source: "music-tools",
    context: {
      contextRef: setRef,
      conversationId: set.conversationId,
      domain: "music",
      kind: "selection_set",
      label: set.source === "daily_recommendation" ? "网易云今日推荐" : `歌曲搜索：${set.query ?? ""}`,
      attributes: { source: [set.source] },
      lifecycle: "active",
      expiresAt: set.expiresAt,
      source: "tool_result",
    },
  });

  const candidates = set.tracks.map((track, index) => {
    const candidateRef = refs.issue<MusicCandidateRefPayload>({
      conversationId: set.conversationId,
      domain: "music",
      kind: "candidate",
      expiresAt: set.expiresAt,
      value: {
        provider: set.provider,
        setId: set.setId,
        trackId: track.id,
        conversationId: set.conversationId,
      },
    });
    publishEvent(hooks, {
      type: "context_upserted",
      eventId: randomUUID(),
      conversationId: set.conversationId,
      occurredAt: Date.now(),
      source: "music-tools",
      context: {
        contextRef: candidateRef,
        conversationId: set.conversationId,
        domain: "music",
        kind: "candidate",
        label: track.name,
        attributes: {
          artists: track.artists,
          ...(track.album ? { album: [track.album] } : {}),
          source: [set.source],
        },
        position: index + 1,
        presented: false,
        lifecycle: "active",
        expiresAt: set.expiresAt,
        source: "tool_result",
      },
    });
    return {
      candidateRef,
      position: index + 1,
      name: track.name,
      artists: track.artists,
      ...(track.album ? { album: track.album } : {}),
    };
  });
  console.log(
    `[MusicContext/Trace] projected conversation=${set.conversationId} source=${set.source} setRef=${setRef} candidates=${candidates.length}`,
  );
  return { setRef, source: set.source, candidates };
}

export function buildMusicTools(service: MusicService, hooks: MusicToolHooks = {}): ToolDefinition[] {
  const safeContextsBySetId = new Map<string, SafeMusicContext>();
  const contextForSet = (set: MusicSelectionSet, refs: ContextRefRegistry): SafeMusicContext => {
    const existing = safeContextsBySetId.get(set.setId);
    if (existing) return existing;
    const created = issueSelectionContext(set, refs, hooks);
    safeContextsBySetId.set(set.setId, created);
    return created;
  };
  const presentAndPublish = async (
    setId: string,
    conversationId: string,
    trackIds: string[],
    candidateRefs: string[],
    reasons?: string[],
  ): Promise<{ presented: boolean; reused?: boolean }> => {
    await service.presentTracks({ setId, conversationId, trackIds, reasons });
    const set = service.getSelectionSet(setId, conversationId);
    if (!set || !hooks.sendCard) {
      console.log(`[MusicContext/Trace] presentation conversation=${conversationId} delivered=false reason=no_recipient candidates=${candidateRefs.length}`);
      return { presented: false };
    }
    if (
      set.presentedAt !== undefined
      && set.presentedTrackIds?.length === trackIds.length
      && set.presentedTrackIds.every((trackId, index) => trackId === trackIds[index])
    ) {
      publishEvent(hooks, {
        type: "context_presented",
        eventId: randomUUID(),
        conversationId,
        occurredAt: Date.now(),
        source: "music-tools",
        contextRefs: candidateRefs,
      });
      console.log(`[MusicContext/Trace] presentation conversation=${conversationId} delivered=true reused=true candidates=${candidateRefs.length}`);
      return { presented: true, reused: true };
    }
    const byId = new Map(set.tracks.map((track) => [track.id, track]));
    const displayed = trackIds.map((id) => byId.get(id)).filter((track): track is MusicTrack => Boolean(track));
    const delivered = hooks.sendCard({ setId: set.setId, source: set.source, tracks: displayed });
    if (!delivered) {
      console.log(`[MusicContext/Trace] presentation conversation=${conversationId} delivered=false reason=recipient_unavailable candidates=${candidateRefs.length}`);
      return { presented: false };
    }
    service.markTracksPresented(setId, conversationId, trackIds);
    publishEvent(hooks, {
      type: "context_presented",
      eventId: randomUUID(),
      conversationId,
      occurredAt: Date.now(),
      source: "music-tools",
      contextRefs: candidateRefs,
    });
    console.log(
      `[MusicContext/Trace] presentation conversation=${conversationId} delivered=true candidates=${candidateRefs.length} refs=[${candidateRefs.join(",")}]`,
    );
    return { presented: true };
  };

  return [
    {
      id: "music_get_daily_recommendations",
      capability: "music.daily_recommendations",
      name: "获取今日推荐歌曲",
      description: "获取网易云音乐今日推荐并将前 5 首展示为卡片。需要用户已登录。返回可信候选引用。",
      enabled: true,
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      needsContext: true,
      soulActionLabel: "获取每日推荐",
      soulProjection: {
        projector: "entity_list",
        source: "trusted_internal",
        itemsPath: "context.candidates",
        fields: { title: "name", artists: "artists", album: "album", position: "position" },
      },
      soulErrorMessages: {
        E_ACCOUNT_REQUIRED: "需要登录网易云音乐账号",
        E_BACKEND_NOT_READY: "音乐服务未就绪",
      },
      completionEvidence: [
        { kind: "tool_succeeded" },
      ],
      execute: async (_args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const set = service.getLatestSelectionSet(conversationId, "daily_recommendation")
          ?? await service.getDailyRecommendations(conversationId, { resolutionRunId: ctx?.runId });
        const safeContext = contextForSet(set, refsOf(ctx, hooks));
        const selected = safeContext.candidates.slice(0, 5);
        const presentation = selected.length > 0
          ? await presentAndPublish(
            set.setId,
            conversationId,
            set.tracks.slice(0, 5).map((track) => track.id),
            selected.map((candidate) => candidate.candidateRef),
          )
          : undefined;
        return JSON.stringify({ kind: "recommendations", context: safeContext, presentation });
      },
    },
    {
      id: "music_search",
      capability: "music.search",
      name: "搜索网易云歌曲",
      description: "按关键词搜索网易云音乐。purpose=discover 用于展示候选；purpose=play 用于本轮搜索确认后直接播放唯一结果。返回最多 20 首真实歌曲的可信候选引用。",
      enabled: true,
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "搜索关键词 (1-100 字)" },
          limit: { type: "number", description: "返回数量 (1-20)" },
          purpose: {
            type: "string",
            enum: ["discover", "play"],
            description: "本次搜索目的。由工具阶段结合用户请求和 CITA 上下文明确选择，Tool Runtime 不猜测。",
          },
        },
        required: ["keyword", "purpose"],
      },
      needsContext: true,
      soulActionLabel: "搜索歌曲",
      soulProjection: {
        projector: "entity_list",
        source: "trusted_internal",
        itemsPath: "context.candidates",
        fields: { title: "name", artists: "artists", album: "album", position: "position" },
      },
      soulErrorMessages: {
        E_BACKEND_NOT_READY: "音乐服务未就绪",
        E_INVALID_KEYWORD_EMPTY: "搜索关键词为空",
        E_INVALID_KEYWORD_TOO_LONG: "搜索关键词过长",
      },
      completionEvidence: [
        { kind: "tool_succeeded" },
      ],
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const purpose = args.purpose;
        if (purpose !== "discover" && purpose !== "play") {
          throw new Error("E_MUSIC_SEARCH_PURPOSE_REQUIRED");
        }
        const set = await service.searchTracks(
          String(args.keyword ?? ""),
          conversationId,
          args.limit as number | undefined,
          { resolutionRunId: ctx?.runId, purpose },
        );
        const safeContext = contextForSet(set, refsOf(ctx, hooks));
        const selected = safeContext.candidates.slice(0, 5);
        const shouldPresent = selected.length > 0 && (purpose === "discover" || set.tracks.length > 1);
        const presentation = shouldPresent
          ? await presentAndPublish(
            set.setId,
            conversationId,
            set.tracks.slice(0, 5).map((track) => track.id),
            selected.map((candidate) => candidate.candidateRef),
          )
          : undefined;
        return JSON.stringify({ kind: "search", context: safeContext, presentation });
      },
    },
    {
      id: "music_present_tracks",
      capability: "music.present_tracks",
      name: "呈现已选歌曲为卡片",
      description: "将可信歌曲候选引用渲染为 AG-UI 卡片。候选必须属于同一个集合，最多 5 首。",
      enabled: true,
      risk: "safe",
      inputSchema: {
        type: "object",
        properties: {
          candidateRefs: { type: "array", items: { type: "string" } },
          reasons: { type: "array", items: { type: "string" } },
        },
        required: ["candidateRefs"],
      },
      controlledInput: { candidateRefs: { type: "context_ref_array", kind: "candidate" } },
      needsContext: true,
      soulActionLabel: "展示歌曲列表",
      soulErrorMessages: {
        E_MUSIC_MIXED_CONTEXT_SET: "候选歌曲不属于同一列表",
        E_SET_NOT_FOUND: "候选列表不存在",
      },
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const candidateRefs = Array.isArray(args.candidateRefs) ? args.candidateRefs.map(String) : [];
        const refs = refsOf(ctx, hooks);
        const payloads = candidateRefs.map((ref) => refs.resolve<MusicCandidateRefPayload>(ref, conversationId, "candidate"));
        const first = payloads[0];
        if (!first || payloads.some((payload) => (
          payload.setId !== first.setId
          || payload.provider !== first.provider
          || payload.conversationId !== conversationId
        ))) throw new Error("E_MUSIC_MIXED_CONTEXT_SET");
        const presentation = await presentAndPublish(
          first.setId,
          conversationId,
          payloads.map((payload) => payload.trackId),
          candidateRefs,
          Array.isArray(args.reasons) ? args.reasons.map(String) : undefined,
        );
        return JSON.stringify({ kind: "presentation", ...presentation });
      },
    },
    {
      id: "music_play_track",
      capability: "music.play_track",
      name: "播放网易云歌曲",
      description: "向默认音乐来源发送播放请求。仅接受 CITA 提供的可信歌曲候选引用；dispatched 不等于已开始播放。",
      enabled: true,
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          candidateRef: { type: "string", description: "CITA 提供的可信歌曲候选引用" },
        },
        required: ["candidateRef"],
      },
      controlledInput: { candidateRef: { type: "context_ref", kind: "candidate" } },
      needsContext: true,
      soulActionLabel: "播放歌曲",
      soulProjection: {
        projector: "action_dispatch",
        source: "trusted_internal",
        statePath: "dispatch.state",
        stateClaims: {
          dispatched: { kind: "request_dispatched" },
          web_fallback: { kind: "browser_opened" },
        },
      },
      soulErrorMessages: {
        E_TRACK_NOT_PLAYABLE: "该歌曲不可播放",
        E_TRACK_NOT_IN_SET: "歌曲不在当前候选列表中",
        E_PLAYBACK_DISPATCH_FAILED: "播放请求发送失败",
        E_CONTEXT_REF_NOT_FOUND: "引用已失效",
        E_CONTEXT_REF_EXPIRED: "引用已过期",
      },
      completionEvidence: [
        { kind: "projection_claim", claimKind: "request_dispatched" },
        { kind: "projection_claim", claimKind: "browser_opened" },
      ],
      execute: async (args, ctx) => {
        const conversationId = conversationIdOf(ctx);
        const candidateRef = String(args.candidateRef ?? "");
        console.log(`[MusicContext/Trace] playback-resolve conversation=${conversationId} ref=${candidateRef || "(empty)"}`);
        const payload = refsOf(ctx, hooks).resolve<MusicCandidateRefPayload>(candidateRef, conversationId, "candidate");
        if (payload.conversationId !== conversationId) throw new Error("E_CONTEXT_REF_CONVERSATION_MISMATCH");
        console.log(`[MusicContext/Trace] playback-resolved conversation=${conversationId} ref=${candidateRef}`);
        const dispatch = await service.playTrack({ ...payload, conversationId, runId: ctx?.runId });
        return JSON.stringify({ kind: "playback", dispatch });
      },
    },
    {
      id: "music_play_playlist",
      capability: "music.play_playlist",
      name: "播放网易云歌单",
      description: "通过本地网易云客户端播放指定歌单 ID。",
      enabled: true,
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: { playlistId: { type: "string" } },
        required: ["playlistId"],
      },
      controlledInput: { playlistId: "tool_result" },
      soulActionLabel: "播放歌单",
      soulProjection: {
        projector: "action_dispatch",
        source: "trusted_internal",
        statePath: "dispatch.state",
        stateClaims: {
          dispatched: { kind: "request_dispatched" },
          web_fallback: { kind: "browser_opened" },
        },
      },
      soulErrorMessages: {
        E_INVALID_ID_FORMAT: "歌单 ID 格式无效",
        E_PLAYBACK_DISPATCH_FAILED: "播放请求发送失败",
      },
      completionEvidence: [
        { kind: "projection_claim", claimKind: "request_dispatched" },
        { kind: "projection_claim", claimKind: "browser_opened" },
      ],
      execute: async (args) => {
        const dispatch = await service.playPlaylist(String(args.playlistId));
        return JSON.stringify({ kind: "playback", dispatch });
      },
    },
  ];
}
