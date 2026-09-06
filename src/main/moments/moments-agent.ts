// Moments（动态 / 朋友圈）的 LLM 调用：评价用户动态 + 生成评论回复。
//
// 后台调用规范（照 runProactiveModel 的约束）：
// - 非流式、maxTokens 600，消息里不得含 tool 内容；
// - JSON 决策输出 + 容错解析，解析失败一律静默放弃，不影响主流程；
// - 由 moments-service 经后台串行队列调度，本模块不做排队；
// - 记录 token 用量。

import { recordUsage, recordRequest } from "../token-usage-store";
import {
  getAdapterForConfig,
  type ChatMessage,
  type VendorConfig,
} from "../orchestrator/vendors";
import type { ChatMessageContent, OpenAIContentBlock } from "../orchestrator/vendors/types";
import {
  MOMENT_MAX_COMMENT_TEXT_LENGTH,
  type MomentComment,
  type MomentFeedItem,
  type MomentMedia,
  type MomentPost,
  type MomentPostSource,
} from "../../shared/moments-types";
import { buildPostGenerationPacket } from "./moments-context";
import { buildMomentImageQuery } from "./moment-media-matcher";
import { MOMENTS_CYRENE_POST_TEXT_MAX } from "./moments-policy";

export const MOMENTS_MODEL_MAX_TOKENS = 600;

// ── 决策类型 ────────────────────────────────────────────────────

/** 评价用户动态的决策结果：点赞 / 评论 / 都不做 / 输出无效。 */
export type MomentReactionDecision =
  | { kind: "react"; like: boolean; commentText: string | null }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: string };

/** 评论线程回复的决策结果。 */
export type MomentReplyDecision =
  | { kind: "reply"; text: string }
  | { kind: "skip" }
  | { kind: "invalid"; reason: string };

/** 主动发帖的决策结果。 */
export type MomentPostDecision =
  | { kind: "post"; text: string; wantImage: boolean }
  | { kind: "skip" }
  | { kind: "invalid"; reason: string };

export type MomentsModelOutput =
  | { kind: "text"; text: string }
  | { kind: "error"; reason: string };

// ── prompt 构建 ─────────────────────────────────────────────────

const MOMENTS_REACT_SYSTEM = `[moments_react_system]
你正在浏览用户刚刚发出的朋友圈动态，决定是否点赞、是否评论。
不是每条动态都值得反应：内容空洞的动态（例如随手测试、单字符、无意义的灌水）可以既不点赞也不评论，不必勉强。
点赞表示你注意到了这条动态；评论应当简短自然，像朋友在朋友圈下留言，一两句话即可。
不要说教，不要复述动态原文，不要提及系统、规则、评分或决策机制。
不要声称自己看到了动态内容以外的信息。`;

const MOMENTS_REPLY_SYSTEM = `[moments_reply_system]
用户在朋友圈动态的评论区回复了你。请决定是否回应。
不需要回复的评论（例如单纯的表情、附和）可以选择不回复。
回复应当简短自然，延续评论区的语气，不要每次都以反问结尾。
不要提及系统、规则、评分或决策机制，不要声称自己看到了评论区以外的信息。`;

const MOMENTS_POST_SYSTEM = `[moments_post_system]
你和用户刚结束一段对话，现在考虑要不要把此刻的心情发到你自己的朋友圈。
不是每段对话都值得发：只有真正有纪念意义、有情绪价值或值得记录的时刻才发，例如完成了一件折腾很久的事、一次开心的闲聊、一个约定。
日常问答、琐碎求助、没有情绪起伏的对话不值得发。
文案用第一人称，像朋友随手发的朋友圈，一两句话即可。
不要提及系统、规则、评分或决策机制，不要在文案里使用"对话""用户"这类词。
不要暴露用户的隐私细节，不要大段复述用户原话。`;

/** 用户动态图片读取结果：dataUrl 直发多模态模型；读取失败带 error 降级文字说明 */
export interface MomentPostImage {
  name: string;
  dataUrl?: string;
  error?: string;
}

/** 用户动态图片挂到 user 消息尾部：成功转 image_url block 直发，失败降级"无法读取"文字块 */
export function appendImageBlocks(text: string, images?: readonly MomentPostImage[]): ChatMessageContent {
  if (!images || images.length === 0) return text;
  const blocks: OpenAIContentBlock[] = [{ type: "text", text }];
  for (const image of images) {
    if (image.dataUrl) {
      blocks.push({ type: "image_url", image_url: { url: image.dataUrl } });
    } else {
      blocks.push({
        type: "text",
        text: `图片 ${image.name} 无法读取：${image.error ?? "未知原因"}。请诚实说明暂时无法看清这张图，不要编造图片内容。`,
      });
    }
  }
  return blocks;
}

const MAX_THREAD_COMMENTS = 20;
const MAX_THREAD_CHARS = 4000;
const MAX_EXCERPT_CHARS = 2000;

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateTime(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 评论行前缀用的时分（HH:mm） */
export function formatClock(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** prompt 里注入的当前时间（日期 + 星期） */
export function formatNow(now: Date): string {
  return `${formatDateTime(now.getTime())} 周${WEEKDAYS[now.getDay()]}`;
}

function authorLabel(author: MomentComment["author"]): string {
  return author === "cyrene" ? "昔涟" : "用户";
}

/**
 * 组装评论线程行：触发评论的回复链全量 + 最近 20 条，按时间正序。
 * 字符超出预算时从最旧的行开始丢弃，保住最新上下文。
 */
function buildThreadLines(comments: readonly MomentComment[], replyTargetId: string): string[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const chain = new Set<MomentComment>();
  let cursor = byId.get(replyTargetId);
  while (cursor && !chain.has(cursor)) {
    chain.add(cursor);
    cursor = cursor.replyTo ? byId.get(cursor.replyTo) : undefined;
  }
  const recent = [...comments]
    .filter((comment) => comment.content.trim())
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_THREAD_COMMENTS);
  const merged = [...new Set([...recent, ...chain])].sort((a, b) => a.createdAt - b.createdAt);
  return merged.map((comment) => {
    const target = comment.replyTo ? byId.get(comment.replyTo) : undefined;
    const replyMark = target ? `（回复${authorLabel(target.author)}）` : "";
    return `[${formatClock(comment.createdAt)}] ${authorLabel(comment.author)}${replyMark}：${comment.content.trim()}`;
  });
}
export interface BuildReactionMessagesInput {
  persona: string;
  /** 关键词命中的 worldbook 设定块（含常驻）；空串表示无命中不注入 */
  worldbook?: string;
  post: { title?: string; text: string; imageCount: number; images?: MomentPostImage[] };
  localNow: Date;
}

export function buildReactionMessages(input: BuildReactionMessagesInput): ChatMessage[] {
  const system = [input.persona.trim(), input.worldbook?.trim(), MOMENTS_REACT_SYSTEM].filter(Boolean).join("\n\n---\n\n");

  const lines = ["[用户发布的朋友圈动态]"];
  if (input.post.title?.trim()) lines.push(`标题：${input.post.title.trim()}`);
  lines.push(`正文：${input.post.text.trim()}`);
  lines.push(`配图：${input.post.imageCount} 张`);
  lines.push(`当前时间：${formatNow(input.localNow)}`);

  const user = `${lines.join("\n")}

请只返回以下一种 JSON，不要使用 Markdown 代码块，也不要添加解释：
{"like":true,"comment":{"shouldComment":true,"text":"要留下的评论"}}
或
{"like":true,"comment":{"shouldComment":false}}
或
{"like":false,"comment":{"shouldComment":false}}`;

  return [
    { role: "system", content: system },
    { role: "user", content: appendImageBlocks(user, input.post.images) },
  ];
}

export interface BuildReplyMessagesInput {
  persona: string;
  /** 关键词命中的 worldbook 设定块（含常驻）；空串表示无命中不注入 */
  worldbook?: string;
  post: MomentPost;
  /** 用户动态图片（原始动态带图时直发多模态模型，帮助理解评论区在聊什么） */
  postImages?: MomentPostImage[];
  comments: readonly MomentComment[];
  /** 触发本次回复的用户评论 id，其回复链必须完整保留 */
  replyTargetId: string;
  /** 动态的触发摘录（仅昔涟由对话驱动的动态才有，供理解发帖语境） */
  triggerExcerpt?: string;
  localNow: Date;
}

export function buildReplyMessages(input: BuildReplyMessagesInput): ChatMessage[] {
  const system = [input.persona.trim(), input.worldbook?.trim(), MOMENTS_REPLY_SYSTEM].filter(Boolean).join("\n\n---\n\n");

  const postLines = [
    "[原始动态]",
    `发布者：${authorLabel(input.post.author)}`,
    `发布时间：${formatDateTime(input.post.createdAt)}`,
  ];
  if (input.post.title?.trim()) postLines.push(`标题：${input.post.title.trim()}`);
  postLines.push(`正文：${input.post.text.trim()}`);
  postLines.push(`配图：${input.post.media.length} 张`);

  let threadLines = buildThreadLines(input.comments, input.replyTargetId);
  let thread = threadLines.join("\n");
  while (thread.length > MAX_THREAD_CHARS && threadLines.length > 1) {
    threadLines = threadLines.slice(1);
    thread = threadLines.join("\n");
  }
  if (thread.length > MAX_THREAD_CHARS) thread = thread.slice(0, MAX_THREAD_CHARS);
  thread = thread || "（暂无）";

  const userParts = [
    postLines.join("\n"),
    `[评论线程]\n${thread}`,
  ];
  if (input.triggerExcerpt?.trim()) {
    userParts.push(`[触发摘录]\n${input.triggerExcerpt.trim().slice(0, MAX_EXCERPT_CHARS)}`);
  }
  userParts.push(`当前时间：${formatNow(input.localNow)}`);
  userParts.push("用户刚刚在评论区回复了你。");

  const user = `${userParts.join("\n\n")}

请只返回以下一种 JSON，不要使用 Markdown 代码块，也不要添加解释：
{"shouldReply":true,"text":"要发布的回复"}
或
{"shouldReply":false,"text":""}`;

  return [
    { role: "system", content: system },
    { role: "user", content: appendImageBlocks(user, input.postImages) },
  ];
}

export interface BuildPostGenerationMessagesInput {
  persona: string;
  /** 关键词命中的 worldbook 设定块（含常驻）；空串表示无命中不注入 */
  worldbook?: string;
  /** 触发摘录：ring buffer 组装的会话原文 */
  summary: string;
  /** 最近昔涟动态（供新颖性判断） */
  recentCyrenePosts: readonly MomentPost[];
  localNow: Date;
}

export function buildPostGenerationMessages(input: BuildPostGenerationMessagesInput): ChatMessage[] {
  const system = [input.persona.trim(), input.worldbook?.trim(), MOMENTS_POST_SYSTEM].filter(Boolean).join("\n\n---\n\n");
  const packet = buildPostGenerationPacket({
    summary: input.summary,
    recentCyrenePosts: input.recentCyrenePosts,
    localNow: input.localNow,
  });
  const user = `${packet}

请只返回以下一种 JSON，不要使用 Markdown 代码块，也不要添加解释：
{"shouldPost":true,"text":"要发布的动态文案","wantImage":false}
或
{"shouldPost":false,"text":""}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ── 决策解析 ────────────────────────────────────────────────────

export function parseReactionDecision(text: string): MomentReactionDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { kind: "invalid", reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  const value = parsed as { like?: unknown; comment?: unknown };
  if (typeof value.like !== "boolean") return { kind: "invalid", reason: "invalid_like" };

  let commentText: string | null = null;
  if (value.comment !== undefined && value.comment !== null) {
    if (!value.comment || typeof value.comment !== "object" || Array.isArray(value.comment)) {
      return { kind: "invalid", reason: "invalid_comment" };
    }
    const comment = value.comment as { shouldComment?: unknown; text?: unknown };
    if (typeof comment.shouldComment !== "boolean") {
      return { kind: "invalid", reason: "invalid_should_comment" };
    }
    if (comment.shouldComment) {
      if (typeof comment.text !== "string" || !comment.text.trim()) {
        return { kind: "invalid", reason: "empty_comment_text" };
      }
      const cleaned = comment.text.trim();
      if (cleaned.length > MOMENT_MAX_COMMENT_TEXT_LENGTH) {
        return { kind: "invalid", reason: "comment_text_too_long" };
      }
      commentText = cleaned;
    }
  }

  if (!value.like && commentText === null) return { kind: "ignore" };
  return { kind: "react", like: value.like, commentText };
}

export function parseReplyDecision(text: string): MomentReplyDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { kind: "invalid", reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  const value = parsed as { shouldReply?: unknown; text?: unknown };
  if (value.shouldReply === false) return { kind: "skip" };
  if (value.shouldReply !== true) return { kind: "invalid", reason: "invalid_should_reply" };
  if (typeof value.text !== "string" || !value.text.trim()) {
    return { kind: "invalid", reason: "empty_text" };
  }
  const cleaned = value.text.trim();
  if (cleaned.length > MOMENT_MAX_COMMENT_TEXT_LENGTH) {
    return { kind: "invalid", reason: "text_too_long" };
  }
  return { kind: "reply", text: cleaned };
}

export function parsePostDecision(text: string): MomentPostDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { kind: "invalid", reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "invalid_shape" };
  }
  const value = parsed as { shouldPost?: unknown; text?: unknown; wantImage?: unknown };
  if (value.shouldPost === false) return { kind: "skip" };
  if (value.shouldPost !== true) return { kind: "invalid", reason: "invalid_should_post" };
  if (typeof value.text !== "string" || !value.text.trim()) {
    return { kind: "invalid", reason: "empty_text" };
  }
  const cleaned = value.text.trim();
  if (cleaned.length > MOMENTS_CYRENE_POST_TEXT_MAX) {
    return { kind: "invalid", reason: "text_too_long" };
  }
  return { kind: "post", text: cleaned, wantImage: value.wantImage === true };
}
// ── 后台模型调用（结构照 runProactiveModel） ─────────────────────

export interface RunMomentsModelInput {
  settings: VendorConfig;
  messages: ChatMessage[];
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

function containsToolContent(messages: ChatMessage[]): boolean {
  return messages.some((message) => (
    message.role === "tool" ||
    Boolean(message.toolCallId) ||
    Boolean(message.toolCalls?.length)
  ));
}

/** 非流式后台调用，返回模型原始文本，由调用方做决策解析。 */
export async function runMomentsModel(input: RunMomentsModelInput): Promise<MomentsModelOutput> {
  if (containsToolContent(input.messages)) {
    return { kind: "error", reason: "tool_content_forbidden" };
  }

  const adapter = getAdapterForConfig(input.settings);
  const request = adapter.buildRequest({
    model: input.settings.model,
    messages: input.messages,
    stream: false,
    maxTokens: MOMENTS_MODEL_MAX_TOKENS,
  }, input.settings);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, input.timeoutMs));
  try {
    const response = await (input.fetchFn ?? fetch)(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    if (!response.ok) return { kind: "error", reason: `http_${response.status}` };

    const raw = await response.json();
    let parsedResponse;
    try {
      parsedResponse = adapter.parseResponse(raw);
    } catch {
      return { kind: "error", reason: "invalid_provider_response" };
    }
    recordRequest(input.settings.model);
    if (parsedResponse.usage) {
      recordUsage(parsedResponse.usage.input, parsedResponse.usage.output, 1, parsedResponse.usage.cachedInput, input.settings.model, parsedResponse.usage.cacheCreation);
    }
    return { kind: "text", text: parsedResponse.text ?? "" };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { kind: "error", reason: name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

// ── Agent：决策 → 提交 ──────────────────────────────────────────

export interface MomentsAgentDeps {
  buildPersona: () => string;
  runModel: (messages: ChatMessage[]) => Promise<MomentsModelOutput>;
  /** 提交昔涟点赞（store 串行队列内含开关与存在性复核） */
  commitLike: (postId: string) => Promise<unknown>;
  /** 提交昔涟评论 */
  commitComment: (input: { postId: string; content: string; replyTo?: string }) => Promise<unknown>;
  /** 提交昔涟动态（store 串行队列内含开关复核）；返回 applied 表示真的落库 */
  commitPost: (input: { text: string; media: MomentMedia[]; source: MomentPostSource }) => Promise<{ applied: boolean }>;
  /** 后置配图匹配：wantImage 时按文案+摘录选官方素材；未命中返回 null（纯文字降级） */
  matchMedia: (query: string) => Promise<MomentMedia | null>;
  /** 关键词命中 worldbook 设定（含常驻）；未注入或无命中时返回空串 */
  buildWorldbookContext?: (text: string) => string;
  /** 读取用户动态图片（user_attachment 副本）转 base64 直发多模态模型；未注入时不带图 */
  loadPostImages?: (post: MomentPost) => MomentPostImage[];
  /** 执行时重读动态与评论线程：AI 思考期间世界可能已变 */
  loadFeedItem: (postId: string) => MomentFeedItem | null;
  log?: (event: string, detail?: unknown) => void;
}

export interface MomentsAgent {
  evaluateUserPost: (post: MomentPost) => Promise<void>;
  generateCommentReply: (postId: string, replyTargetId: string) => Promise<void>;
  /** 主动发帖决策：返回是否真的发出了动态（供策略层记账） */
  generatePost: (input: { summary: string; recentCyrenePosts: readonly MomentPost[] }) => Promise<boolean>;
}

export function createMomentsAgent(deps: MomentsAgentDeps): MomentsAgent {
  async function evaluateUserPost(post: MomentPost): Promise<void> {
    const output = await deps.runModel(buildReactionMessages({
      persona: deps.buildPersona(),
      // 用户动态文本扫 worldbook 关键词，命中注入设定防幻觉
      worldbook: deps.buildWorldbookContext?.([post.title ?? "", post.text].filter(Boolean).join("\n")) ?? "",
      post: {
        title: post.title,
        text: post.text,
        imageCount: post.media.length,
        images: deps.loadPostImages?.(post),
      },
      localNow: new Date(),
    }));
    if (output.kind !== "text") return;

    const decision = parseReactionDecision(output.text);
    if (decision.kind === "invalid") {
      deps.log?.("reaction_decision_invalid", decision.reason);
      return;
    }
    if (decision.kind === "ignore") return;
    if (decision.like) await deps.commitLike(post.id);
    if (decision.commentText) {
      await deps.commitComment({ postId: post.id, content: decision.commentText });
    }
  }

  async function generateCommentReply(postId: string, replyTargetId: string): Promise<void> {
    // 执行时重读：动态或触发评论已被删除时静默放弃
    const feed = deps.loadFeedItem(postId);
    if (!feed) return;
    if (!feed.comments.some((comment) => comment.id === replyTargetId)) return;

    const output = await deps.runModel(buildReplyMessages({
      persona: deps.buildPersona(),
      // 动态正文 + 评论文本 + 触发摘录合并扫 worldbook 关键词
      worldbook: deps.buildWorldbookContext?.([
        feed.post.title ?? "",
        feed.post.text,
        ...feed.comments.map((comment) => comment.content),
        feed.post.source?.triggerExcerpt ?? "",
      ].filter(Boolean).join("\n")) ?? "",
      post: feed.post,
      postImages: deps.loadPostImages?.(feed.post),
      comments: feed.comments,
      replyTargetId,
      triggerExcerpt: feed.post.source?.triggerExcerpt,
      localNow: new Date(),
    }));
    if (output.kind !== "text") return;

    const decision = parseReplyDecision(output.text);
    if (decision.kind === "invalid") {
      deps.log?.("reply_decision_invalid", decision.reason);
      return;
    }
    if (decision.kind === "skip") return;
    await deps.commitComment({ postId, content: decision.text, replyTo: replyTargetId });
  }

  async function generatePost(input: { summary: string; recentCyrenePosts: readonly MomentPost[] }): Promise<boolean> {
    const output = await deps.runModel(buildPostGenerationMessages({
      persona: deps.buildPersona(),
      // 会话摘录扫 worldbook 关键词，发帖文案才能贴合设定
      worldbook: deps.buildWorldbookContext?.(input.summary) ?? "",
      summary: input.summary,
      recentCyrenePosts: input.recentCyrenePosts,
      localNow: new Date(),
    }));
    if (output.kind !== "text") return false;

    const decision = parsePostDecision(output.text);
    if (decision.kind === "invalid") {
      deps.log?.("post_decision_invalid", decision.reason);
      return false;
    }
    if (decision.kind === "skip") return false;

    // 后置配图：LLM 只表态想要图，选图由本地 embedding 匹配完成；
    // 未命中阈值 / 索引未就绪时降级纯文字，不硬凑图
    let media: MomentMedia[] = [];
    if (decision.wantImage) {
      const query = buildMomentImageQuery(decision.text, input.summary, new Date());
      const matched = await deps.matchMedia(query);
      if (matched) media = [matched];
    }

    const result = await deps.commitPost({
      text: decision.text,
      media,
      source: { type: "conversation", triggerExcerpt: input.summary },
    });
    return result.applied;
  }

  return { evaluateUserPost, generateCommentReply, generatePost };
}