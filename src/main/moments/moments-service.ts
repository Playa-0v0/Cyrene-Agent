// Moments 对外唯一门面：IPC 与组合根都只碰它。
//
// 职责：
// - 包装 moments-store 的 CRUD（读走内存缓存，写走串行队列）；
// - 用户发帖 / 评论成功后调度昔涟反应（后台 LLM，经 enqueueLLMTask 串行）；
// - 规则闸门前置：反应开关关闭或模型未配置时直接跳过，不浪费 token。
//
// 昔涟反应分两段：agent 只产出决策（stale/retry/invalid/decided），
// 落库由本模块统一执行——决策与副作用分离，同样的两段后续可平移到
// 反应队列的 decide/apply 执行器上。

import { enqueueLLMTask } from "../llm-queue";
import { loadGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings } from "../settings/model-settings";
import { loadPromptFile } from "../prompts/prompt-loader";
import type { ChatMessage, VendorConfig } from "../orchestrator/vendors";
import * as path from "path";
import { getEmbeddingProvider } from "../rag/embedding";
import { getKeywordMatchedWorldbookEntries, getPermanentWorldbookEntries } from "../rag";
import { validateCaptionImagePath } from "../chat/image-caption";
import { matchSticker, type StickerEmbeddingEntry } from "../sticker-embedder";
import { resolveMomentStickerMedia } from "./moment-media-matcher";
import * as momentsStore from "./moments-store";
import {
  createMomentsAgent,
  runMomentsModel,
  type MomentsAgent,
  type MomentsModelOutput,
  type MomentPostImage,
} from "./moments-agent";
import {
  buildConversationSummary,
  type ConversationSummaryTurn,
} from "./moments-context";
import type { ReactionDecision, ReactionDecideOutcome } from "./reaction-queue";
import {
  buildMomentsEventKey,
  canPost,
  loadMomentsPolicyState,
  recordEventKey,
  recordPost,
  saveMomentsPolicyState,
  type MomentsPolicyState,
} from "./moments-policy";
import type {
  MomentComment,
  MomentCommitResult,
  MomentMedia,
  MomentCreateCommentInput,
  MomentCreatePostInput,
  MomentFeedItem,
  MomentPost,
} from "../../shared/moments-types";

const MOMENTS_MODEL_TIMEOUT_MS = 45_000;

/** ring buffer 保留的最近轮数（MomentEvent.summary 的原料） */
const RING_BUFFER_MAX_TURNS = 6;
/** 供新颖性判断的最近昔涟动态条数 */
const RECENT_CYRENE_POSTS_FOR_NOVELTY = 5;

/** Moments 一次 run 收尾的输入（事件产生时冻结的不可变快照）。 */
export interface MomentsTurnInput {
  conversationId: string;
  runId?: string;
  source: "desktop" | "channel";
  mode: string;
  channel?: string;
  userText: string;
  assistantReply: string;
  finishedAt: number;
}

export interface MomentsService {
  listFeed: (options?: { limit?: number; before?: number }) => MomentFeedItem[];
  getFeedItem: (postId: string) => MomentFeedItem | null;
  createUserPost: (input: MomentCreatePostInput) => Promise<MomentCommitResult<MomentPost>>;
  deletePost: (postId: string) => Promise<MomentCommitResult<null>>;
  createUserComment: (input: MomentCreateCommentInput) => Promise<MomentCommitResult<MomentComment>>;
  toggleUserLike: (postId: string) => Promise<MomentCommitResult<{ liked: boolean }>>;
  /** run 成功收尾时调用：记录 ring buffer 并按策略调度昔涟主动发帖。 */
  scheduleTurn: (input: MomentsTurnInput) => void;
}

interface MomentsStoreFacade {
  listFeed: typeof momentsStore.listFeed;
  getFeedItem: typeof momentsStore.getFeedItem;
  createUserPost: typeof momentsStore.createUserPost;
  deletePost: typeof momentsStore.deletePost;
  createComment: typeof momentsStore.createComment;
  toggleLike: typeof momentsStore.toggleLike;
  createCyreneLike: typeof momentsStore.createCyreneLike;
  createCyrenePost: typeof momentsStore.createCyrenePost;
}

export interface MomentsServiceDeps {
  store: MomentsStoreFacade;
  loadGeneralSettings: () => {
    momentsEnabled: boolean;
    cyreneMomentsReactionsEnabled: boolean;
    cyreneMomentsPostingEnabled: boolean;
  };
  /** 返回 null 表示模型未配置（缺 API key 等），反应调度直接跳过 */
  loadVendorConfig: () => VendorConfig | null;
  buildPersona: () => string;
  enqueueTask: (label: string, task: () => Promise<void>) => Promise<void>;
  runModel: (messages: ChatMessage[]) => Promise<MomentsModelOutput>;
  /** 策略状态存取（默认读写 moments-state.json；测试注入内存版） */
  loadPolicyState?: () => MomentsPolicyState;
  savePolicyState?: (state: MomentsPolicyState) => void;
  /** 后置配图匹配（未注入或未命中时纯文字发帖） */
  matchMedia?: (query: string) => Promise<MomentMedia | null>;
  /** 关键词命中 worldbook 设定块（未注入时降级空串，不注入设定） */
  buildWorldbookContext?: (text: string) => string;
  /** 读取用户动态图片转 base64（未注入时不带图） */
  loadPostImages?: (post: MomentPost) => MomentPostImage[];
  log?: (event: string, detail?: unknown) => void;
}

export function createMomentsService(deps: MomentsServiceDeps): MomentsService {
  const agent: MomentsAgent = createMomentsAgent({
    buildPersona: deps.buildPersona,
    runModel: deps.runModel,
    commitPost: (input) => deps.store.createCyrenePost(input),
    loadFeedItem: (postId) => deps.store.getFeedItem(postId),
    matchMedia: deps.matchMedia ?? (async () => null),
    buildWorldbookContext: deps.buildWorldbookContext,
    loadPostImages: deps.loadPostImages,
    log: deps.log,
  });

  const loadPolicyState = deps.loadPolicyState ?? loadMomentsPolicyState;
  const savePolicyState = deps.savePolicyState ?? saveMomentsPolicyState;

  // per-conversation ring buffer：MomentEvent.summary 的原料（内存态，V1 从简不落盘）
  const conversationTurns = new Map<string, ConversationSummaryTurn[]>();

  function postingEnabled(): boolean {
    const settings = deps.loadGeneralSettings();
    return settings.momentsEnabled && settings.cyreneMomentsPostingEnabled;
  }

  function reactionsEnabled(): boolean {
    const settings = deps.loadGeneralSettings();
    return settings.momentsEnabled && settings.cyreneMomentsReactionsEnabled;
  }

  /** 闸门前置省 token：开关关闭或模型未配置时不入队。 */
  function scheduleReaction(label: string, task: () => Promise<void>): void {
    if (!reactionsEnabled()) return;
    if (deps.loadVendorConfig() === null) return;
    deps.enqueueTask(label, task).catch((error) => {
      deps.log?.("reaction_task_failed", error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * 昔涟表态决策落库：点赞走昔涟点赞通道，评论/回复走昔涟评论通道
   * （store 串行队列内含开关与目标存在性复核，AI 思考期间世界变化不豁免）。
   */
  async function applyCyreneReaction(
    target: { postId: string; replyTo?: string },
    decision: ReactionDecision,
  ): Promise<void> {
    if (decision.action === "like" || decision.action === "like_comment") {
      await deps.store.createCyreneLike(target.postId);
    }
    if (decision.action === "comment" || decision.action === "like_comment" || decision.action === "reply") {
      await deps.store.createComment(
        { postId: target.postId, content: decision.comment, replyTo: target.replyTo },
        "cyrene",
      );
    }
  }

  /** 非 decided 或 silent 的结局对直通路径都是"什么都不做"：stale/invalid/retry 由队列语义接管重试与放弃 */
  async function runCyreneReaction(outcome: ReactionDecideOutcome, target: { postId: string; replyTo?: string }): Promise<void> {
    if (outcome.type !== "decided") return;
    if (outcome.decision.action === "silent") return;
    await applyCyreneReaction(target, outcome.decision);
  }

  function scheduleUserPostReaction(postId: string): void {
    scheduleReaction("MomentsReact", () =>
      agent.decideUserPostReaction(postId).then((outcome) => runCyreneReaction(outcome, { postId })));
  }

  function scheduleCommentReply(input: MomentCreateCommentInput, committed: MomentComment): void {
    // 仅"回复昔涟"的评论才触发回复：昔涟自己的动态，或回复目标是昔涟的评论
    const feed = deps.store.getFeedItem(input.postId);
    if (!feed) return;
    const targetsCyrene =
      feed.post.author === "cyrene" ||
      (input.replyTo !== undefined &&
        feed.comments.some((comment) => comment.id === input.replyTo && comment.author === "cyrene"));
    if (!targetsCyrene) return;
    scheduleReaction("MomentsReply", () =>
      agent.decideCommentReply(input.postId, committed.id)
        .then((outcome) => runCyreneReaction(outcome, { postId: input.postId, replyTo: committed.id })));
  }

  /** run 成功收尾：记录 ring buffer → 设置/去重闸门（LLM 前）→ 入队生成。 */
  function scheduleTurn(input: MomentsTurnInput): void {
    // ring buffer 永远记录：后续事件的摘录需要这段上下文，与发帖闸门无关
    const turns = [...(conversationTurns.get(input.conversationId) ?? []), {
      user: input.userText,
      assistant: input.assistantReply,
      at: input.finishedAt,
    }].slice(-RING_BUFFER_MAX_TURNS);
    conversationTurns.set(input.conversationId, turns);

    // 设置闸门前置（省 token）：总开关 + 主动发帖开关 + 模型配置
    if (!postingEnabled()) return;
    if (deps.loadVendorConfig() === null) return;

    // run 粒度去重：同一事件重复到达直接丢弃，键在到达时立即记录
    const eventKey = buildMomentsEventKey(input);
    const state = loadPolicyState();
    if (state.recentEventKeys.includes(eventKey)) return;
    savePolicyState(recordEventKey(state, eventKey));

    // 摘要在事件到达时冻结（快照语义，契约 1）
    const summary = buildConversationSummary(turns);
    deps.enqueueTask("MomentsPost", async () => {
      // 执行时复核冷却与日上限：闸门通过到任务执行之间，世界可能已变
      const gate = canPost(loadPolicyState(), Date.now());
      if (!gate.ok) {
        deps.log?.("post_gated", gate.reason);
        return;
      }
      const recentCyrenePosts = deps.store.listFeed({ limit: 100 })
        .map((item) => item.post)
        .filter((post) => post.author === "cyrene")
        .slice(0, RECENT_CYRENE_POSTS_FOR_NOVELTY);
      const posted = await agent.generatePost({ summary, recentCyrenePosts });
      if (posted) savePolicyState(recordPost(loadPolicyState(), Date.now()));
    }).catch((error) => {
      deps.log?.("post_task_failed", error instanceof Error ? error.message : String(error));
    });
  }

  return {
    listFeed: (options) => deps.store.listFeed(options),
    getFeedItem: (postId) => deps.store.getFeedItem(postId),

    createUserPost: (input) =>
      deps.store.createUserPost(input).then((result) => {
        if (result.applied) scheduleUserPostReaction(result.value.id);
        return result;
      }),

    deletePost: (postId) => deps.store.deletePost(postId),

    createUserComment: (input) =>
      deps.store.createComment(input, "user").then((result) => {
        if (result.applied) scheduleCommentReply(input, result.value);
        return result;
      }),

    toggleUserLike: (postId) => deps.store.toggleLike(postId, "user"),

    scheduleTurn,
  };
}
// ── 配图匹配：贴图 embedding 索引由组合根晚绑定 ─────────────────

let getStickerEmbeddingIndex: () => StickerEmbeddingEntry[] | null = () => null;

/**
 * 组合根注册贴图索引 getter（EmbeddingIndexService 实例在
 * default-dependencies 内创建，模块单例无法静态引用，启动时注入）。
 * 未注册 / 索引未就绪时 matchMedia 返回 null——纯文字降级。
 */
export function registerMomentsMediaMatcher(deps: {
  getStickerIndex: () => StickerEmbeddingEntry[] | null;
}): void {
  getStickerEmbeddingIndex = deps.getStickerIndex;
}

// ── 具体装配（组合根 / IPC 直接使用） ───────────────────────────

/** 人设四件套，与主动聊天共用同源 prompt 文件，且不含工具说明。 */
function buildMomentsPersonaPrompt(): string {
  const parts: string[] = [];
  const chatSystem = loadPromptFile("chat_system.md");
  if (chatSystem) parts.push(chatSystem);
  const soul = loadPromptFile("soul.md");
  if (soul) {
    // 朋友圈场景不携带 Live2D 章节
    parts.push(soul.split("\n## Live2D 与聊天文字的分工")[0].trim());
  }
  const canon = loadPromptFile("canon_quotes.md");
  if (canon) parts.push(canon);
  const style = loadPromptFile("styles/01_default.md");
  if (style) parts.push(style);
  return parts.join("\n\n---\n\n");
}

function loadMomentsVendorConfig(): VendorConfig | null {
  const settings = loadModelSettings();
  if (!settings.apiKey) return null;
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    reasoning: settings.reasoning,
  };
}

/**
 * 具体配图匹配闭包：embedding provider + 晚绑定贴图索引 + 设置里的相似度阈值。
 * provider / 索引任一未就绪或分数未达阈值都返回 null——纯文字降级，不硬凑图。
 */
export function createMomentsMediaMatcher(): (query: string) => Promise<MomentMedia | null> {
  return async (query) => {
    const provider = getEmbeddingProvider();
    const index = getStickerEmbeddingIndex();
    if (!provider || !index) return null;
    const matched = await matchSticker(
      query,
      provider,
      index,
      loadModelSettings().stickerSimilarityThreshold,
    );
    if (!matched) return null;
    // 命中贴图后解析成渲染端可消费的媒体引用；贴图已被删除时降级纯文字
    return resolveMomentStickerMedia(matched.id);
  };
}

/**
 * 具体 worldbook 注入闭包：常驻条目全量 + 文本关键词命中条目，按优先级合并。
 * 供 Moments 各 LLM 调用注入设定（纯关键词触发，不走 DMAE 打分）。
 */
export function buildMomentsWorldbookContext(text: string): string {
  const parts = [...getPermanentWorldbookEntries(), ...getKeywordMatchedWorldbookEntries(text)];
  if (parts.length === 0) return "";
  return `[相关设定]\n${parts.join("\n\n")}`;
}

/**
 * 具体图片读取闭包：用户动态的 user_attachment 副本转 base64 dataUrl，
 * 直发多模态主模型；读取失败降级文字说明，不阻断反应流程。
 * character_asset 是昔涟自己的配图素材，不作为视觉输入。
 */
export function loadUserMomentPostImages(post: MomentPost): MomentPostImage[] {
  // 与主会话同一条规矩：multimodal=false 表示用户明确不把图片字节发给主模型，此时跳过读图
  if (loadModelSettings()?.multimodal === false) return [];
  const images: MomentPostImage[] = [];
  for (const media of post.media) {
    if (media.origin !== "user_attachment") continue;
    const filePath = path.join(momentsStore.getMomentsMediaRootDir(), post.id, media.ref);
    const validated = validateCaptionImagePath(filePath);
    if (validated.ok) {
      images.push({
        name: media.ref,
        dataUrl: `data:${validated.mime};base64,${validated.buffer.toString("base64")}`,
      });
    } else {
      images.push({ name: media.ref, error: validated.error });
    }
  }
  return images;
}

export const momentsService: MomentsService = createMomentsService({
  store: momentsStore,
  loadGeneralSettings,
  loadVendorConfig: loadMomentsVendorConfig,
  matchMedia: createMomentsMediaMatcher(),
  buildWorldbookContext: buildMomentsWorldbookContext,
  loadPostImages: loadUserMomentPostImages,
  buildPersona: buildMomentsPersonaPrompt,
  enqueueTask: (label, task) => enqueueLLMTask(label, task),
  runModel: async (messages) => {
    const config = loadMomentsVendorConfig();
    if (!config) return { kind: "error", reason: "missing_api_key" };
    return runMomentsModel({
      settings: config,
      messages,
      timeoutMs: MOMENTS_MODEL_TIMEOUT_MS,
    });
  },
  log: (event, detail) => console.log(`[Moments] ${event}`, detail ?? ""),
});