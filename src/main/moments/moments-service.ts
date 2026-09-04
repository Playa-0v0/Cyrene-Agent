// Moments 对外唯一门面：IPC 与组合根都只碰它。
//
// 职责：
// - 包装 moments-store 的 CRUD（读走内存缓存，写走串行队列）；
// - 用户发帖 / 评论成功后调度昔涟反应（后台 LLM，经 enqueueLLMTask 串行）；
// - 规则闸门前置：反应开关关闭或模型未配置时直接跳过，不浪费 token。
//
// 昔涟的反应结果由 agent 经 store 的昔涟提交通道落库；
// 提交时在串行队列内复核开关与目标存在性，AI 思考期间世界变化不豁免。

import { enqueueLLMTask } from "../llm-queue";
import { loadGeneralSettings } from "../settings/settings-facade";
import { loadModelSettings } from "../settings/model-settings";
import { loadPromptFile } from "../prompts/prompt-loader";
import type { ChatMessage, VendorConfig } from "../orchestrator/vendors";
import * as momentsStore from "./moments-store";
import {
  createMomentsAgent,
  runMomentsModel,
  type MomentsAgent,
  type MomentsModelOutput,
} from "./moments-agent";
import type {
  MomentComment,
  MomentCommitResult,
  MomentCreateCommentInput,
  MomentCreatePostInput,
  MomentFeedItem,
  MomentPost,
} from "../../shared/moments-types";

const MOMENTS_MODEL_TIMEOUT_MS = 45_000;

export interface MomentsService {
  listFeed: (options?: { limit?: number; before?: number }) => MomentFeedItem[];
  getFeedItem: (postId: string) => MomentFeedItem | null;
  createUserPost: (input: MomentCreatePostInput) => Promise<MomentCommitResult<MomentPost>>;
  deletePost: (postId: string) => Promise<MomentCommitResult<null>>;
  createUserComment: (input: MomentCreateCommentInput) => Promise<MomentCommitResult<MomentComment>>;
  toggleUserLike: (postId: string) => Promise<MomentCommitResult<{ liked: boolean }>>;
}

interface MomentsStoreFacade {
  listFeed: typeof momentsStore.listFeed;
  getFeedItem: typeof momentsStore.getFeedItem;
  createUserPost: typeof momentsStore.createUserPost;
  deletePost: typeof momentsStore.deletePost;
  createComment: typeof momentsStore.createComment;
  toggleLike: typeof momentsStore.toggleLike;
  createCyreneLike: typeof momentsStore.createCyreneLike;
}

export interface MomentsServiceDeps {
  store: MomentsStoreFacade;
  loadGeneralSettings: () => { momentsEnabled: boolean; cyreneMomentsReactionsEnabled: boolean };
  /** 返回 null 表示模型未配置（缺 API key 等），反应调度直接跳过 */
  loadVendorConfig: () => VendorConfig | null;
  buildPersona: () => string;
  enqueueTask: (label: string, task: () => Promise<void>) => Promise<void>;
  runModel: (messages: ChatMessage[]) => Promise<MomentsModelOutput>;
  log?: (event: string, detail?: unknown) => void;
}

export function createMomentsService(deps: MomentsServiceDeps): MomentsService {
  const agent: MomentsAgent = createMomentsAgent({
    buildPersona: deps.buildPersona,
    runModel: deps.runModel,
    commitLike: (postId) => deps.store.createCyreneLike(postId),
    commitComment: (input) => deps.store.createComment(input, "cyrene"),
    loadFeedItem: (postId) => deps.store.getFeedItem(postId),
    log: deps.log,
  });

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

  function scheduleUserPostReaction(post: MomentPost): void {
    scheduleReaction("MomentsReact", () => agent.evaluateUserPost(post));
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
    scheduleReaction("MomentsReply", () => agent.generateCommentReply(input.postId, committed.id));
  }

  return {
    listFeed: (options) => deps.store.listFeed(options),
    getFeedItem: (postId) => deps.store.getFeedItem(postId),

    createUserPost: (input) =>
      deps.store.createUserPost(input).then((result) => {
        if (result.applied) scheduleUserPostReaction(result.value);
        return result;
      }),

    deletePost: (postId) => deps.store.deletePost(postId),

    createUserComment: (input) =>
      deps.store.createComment(input, "user").then((result) => {
        if (result.applied) scheduleCommentReply(input, result.value);
        return result;
      }),

    toggleUserLike: (postId) => deps.store.toggleLike(postId, "user"),
  };
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

export const momentsService: MomentsService = createMomentsService({
  store: momentsStore,
  loadGeneralSettings,
  loadVendorConfig: loadMomentsVendorConfig,
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