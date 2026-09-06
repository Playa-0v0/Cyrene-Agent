// 朋友圈角色注册表与人设加载。
//
// 职责边界：
// - 名单 = 立绘池（TASK_CHARACTERS）∩ 人设 md 实际存在者——没有头像的角色
//   渲染不了，没有角色卡的立绘生成不了内容，交集之外一律跳过并记日志；
// - 程序读 frontmatter（点赞/评论档位 → 调度概率），模型读正文（角色卡本身），
//   两侧解耦：用户改正文措辞不会破坏解析，改档位词即改行为频率；
// - 每次加载都直接读盘、不落盘缓存——md 随时可改，重启或下次加载即生效；
// - 同时承担角色反应的 prompt 组装与决策解析（对动态表态 / 被回复后表态两套契约）。

import * as fs from "node:fs";
import { findPromptPath } from "../external-content-paths";
import { TASK_CHARACTERS } from "../tasks/task-character-pool";
import type { ChatMessage } from "../orchestrator/vendors";
import {
  MOMENT_MAX_COMMENT_TEXT_LENGTH,
  type CharacterTimeline,
  type MomentAuthor,
  type MomentComment,
  type MomentPost,
} from "../../shared/moments-types";
import { appendImageBlocks, formatClock, formatNow, type MomentPostImage } from "./moments-agent";

// ── 档位与概率映射 ──────────────────────────────────────────────
// 三组数值刻意不同：活跃度是"刷到动态"的抽签权重，评论骰是"走模型表态"的概率，
// 点赞骰是"未进评论路径时随手点赞"的概率——同一档位词在三个维度上的绝对值没有可比性。

/** 档位词，从低到高；英文别名仅作兼容，中文为准 */
type LevelWord = "极低" | "低" | "中低" | "中" | "中高" | "高";

const LEVEL_ALIASES: Record<string, LevelWord> = {
  high: "高",
  "mid-high": "中高",
  mid: "中",
  "mid-low": "中低",
  low: "低",
  "very-low": "极低",
};

/** 活跃度 → 抽签权重（多容易"刷到"动态） */
const ACTIVITY_WEIGHTS: Record<LevelWord, number> = {
  高: 0.75,
  中高: 0.5,
  中: 0.35,
  中低: 0.22,
  低: 0.12,
  极低: 0.05,
};

/** 评论骰 → 刷到后走模型表态的概率 */
const COMMENT_DICE: Record<LevelWord, number> = {
  高: 0.5,
  中高: 0.35,
  中: 0.22,
  中低: 0.12,
  低: 0.06,
  极低: 0.03,
};

/** 点赞骰 → 未进评论路径时随手点赞的概率 */
const LIKE_DICE: Record<LevelWord, number> = {
  高: 0.75,
  中高: 0.55,
  中: 0.4,
  中低: 0.25,
  低: 0.12,
  极低: 0.05,
};

/**
 * 特别关注骰 → 用户发动态时额外掷一次专骰，命中即直接刷到（不占普通抽签名额）。
 * 语义是"这位角色对用户的朋友圈格外上心"：大部分动态都会看见，但看见后赞不赞、
 * 评不评仍由双骰和模型决定。未写 presence 键的角色为 0，不参与专骰。
 */
const PRESENCE_DICE: Record<LevelWord, number> = {
  高: 0.8,
  中高: 0.6,
  中: 0.4,
  中低: 0.25,
  低: 0.12,
  极低: 0.05,
};

/** 档位从低到高的序，供"较高档"比较 */
const LEVEL_RANK: Record<LevelWord, number> = {
  极低: 0,
  低: 1,
  中低: 2,
  中: 3,
  中高: 4,
  高: 5,
};

/** 解析档位词：接受中文全量档与英文别名，忽略大小写、首尾空白与行内 # 注释；无法识别返回 null */
function parseLevelWord(raw: string): LevelWord | null {
  const cleaned = raw.split("#")[0].trim().toLowerCase();
  const chinese = ["高", "中高", "中", "中低", "低", "极低"] as const;
  if ((chinese as readonly string[]).includes(cleaned)) return cleaned as LevelWord;
  return LEVEL_ALIASES[cleaned] ?? null;
}

/** 两个档位中较高者 */
function higherLevel(a: LevelWord, b: LevelWord): LevelWord {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

// ── frontmatter 解析（程序读 frontmatter，模型读正文） ──────────

const FRONTMATTER_KEYS = ["activity", "comment", "like", "presence"] as const;

export interface PersonaFrontmatterParse {
  /** 剥离 frontmatter 块后的正文（模型只读这部分） */
  personaText: string;
  /** 四个档位词；未写或写错的位置为 null，由加载方回退 */
  activity: LevelWord | null;
  comment: LevelWord | null;
  like: LevelWord | null;
  /** 用户动态的特别关注档位；未写 = 不参与专骰 */
  presence: LevelWord | null;
  /** 写了但档位词无法识别的键名，供日志提示用户改回 */
  invalidKeys: string[];
}

/**
 * 解析角色卡顶部的 frontmatter 块：
 * - 只有文件第一行是 --- 时才视为 frontmatter，正文中段的 --- 不算；
 * - 键只认 activity / comment / like，其余忽略；整行 # 注释跳过；
 * - 正文内容完全不参与解析——【行为倾向】段落是给模型读的，档位备注再随意也不影响。
 */
export function parsePersonaFrontmatter(raw: string): PersonaFrontmatterParse {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const values: Partial<Record<string, string>> = {};
  const invalidKeys: string[] = [];
  let bodyStart = 0;

  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = /^([\w-]+)\s*:\s*(.*)$/.exec(trimmed);
        if (!match) continue;
        const [, key, value] = match;
        if ((FRONTMATTER_KEYS as readonly string[]).includes(key)) values[key] = value;
      }
      bodyStart = end + 1;
    }
  }

  const parsed: Partial<Record<(typeof FRONTMATTER_KEYS)[number], LevelWord>> = {};
  for (const key of FRONTMATTER_KEYS) {
    const rawValue = values[key];
    if (rawValue === undefined) continue;
    const word = parseLevelWord(rawValue);
    if (word) parsed[key] = word;
    else invalidKeys.push(key);
  }

  return {
    personaText: lines.slice(bodyStart).join("\n").trim(),
    activity: parsed.activity ?? null,
    comment: parsed.comment ?? null,
    like: parsed.like ?? null,
    presence: parsed.presence ?? null,
    invalidKeys,
  };
}

// ── 角色注册表 ──────────────────────────────────────────────────

export interface CharacterPersona {
  nickname: string;
  assetFileName: string;
  /** 角色卡正文（已剥离 frontmatter，含原文短句锚点，供模型阅读） */
  personaText: string;
  /** _header.md 的注入头段落（场景规则，所有角色共享） */
  headerText: string;
  /** 活跃度：抽签时被刷到的权重 */
  activityWeight: number;
  /** 评论骰：刷到后走模型表态的概率 */
  commentDice: number;
  /** 点赞骰：未进评论路径时随手点赞的概率 */
  likeDice: number;
  /** 特别关注骰：用户发动态时的额外刷到概率；0 = 不参与专骰 */
  presenceDice: number;
}

export interface CharacterPersonaLoadOptions {
  /** 覆盖 prompts 搜索目录（默认走应用配置；测试注入临时目录） */
  promptDirectories?: string[];
  log?: (event: string, detail?: unknown) => void;
}

const PERSONAS_DIR = "moments_personas";

/**
 * 加载角色注册表：立绘池与人设 md 的交集。
 * 档位回退规则：comment / like 未写或写错 → 中；activity 未写 → 取两者较高档，
 * 写错 → 中。回退都记日志，不阻断加载。
 */
export function loadCharacterPersonas(options: CharacterPersonaLoadOptions = {}): Map<string, CharacterPersona> {
  const log = options.log ?? (() => {});
  const headerText = loadInjectionHeader(options.promptDirectories);
  const registry = new Map<string, CharacterPersona>();

  for (const { nickname, assetFileName } of TASK_CHARACTERS) {
    const filePath = findPromptPath(`${PERSONAS_DIR}/${nickname}.md`, options.promptDirectories);
    if (!filePath) {
      log("character_persona_missing", { nickname });
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      log("character_persona_read_failed", { nickname, error: String(error) });
      continue;
    }

    const parsed = parsePersonaFrontmatter(raw);
    if (parsed.invalidKeys.length > 0) {
      log("character_persona_level_fallback", { nickname, keys: parsed.invalidKeys });
    }
    const commentWord = parsed.comment ?? "中";
    const likeWord = parsed.like ?? "中";
    const activityWord = parsed.activity
      ?? (parsed.invalidKeys.includes("activity") ? "中" : higherLevel(commentWord, likeWord));
    registry.set(nickname, {
      nickname,
      assetFileName,
      personaText: parsed.personaText,
      headerText,
      activityWeight: ACTIVITY_WEIGHTS[activityWord],
      commentDice: COMMENT_DICE[commentWord],
      likeDice: LIKE_DICE[likeWord],
      presenceDice: parsed.presence ? PRESENCE_DICE[parsed.presence] : 0,
    });
  }

  logPersonasOutsidePool(options.promptDirectories, log);
  return registry;
}

/** 目录里存在但不在立绘池中的角色卡：渲染不出头像，只能跳过；留日志方便排查名字对不上 */
function logPersonasOutsidePool(
  promptDirectories: string[] | undefined,
  log: (event: string, detail?: unknown) => void,
): void {
  const dir = findPromptPath(PERSONAS_DIR, promptDirectories);
  if (!dir) return;
  const knownNames = new Set(TASK_CHARACTERS.map((character) => character.nickname));
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md") || file.startsWith("_")) continue;
      const nickname = file.slice(0, -3);
      if (!knownNames.has(nickname)) log("character_persona_skipped_no_asset", { nickname });
    }
  } catch {
    // 目录读取失败只影响跳过日志，不影响注册表本身
  }
}

/** _header.md 里 "## 注入头" 段落（到下一个二级标题为止），作为所有角色共享的场景规则 */
function loadInjectionHeader(promptDirectories?: string[]): string {
  const headerPath = findPromptPath(`${PERSONAS_DIR}/_header.md`, promptDirectories);
  if (!headerPath) return "";
  let raw: string;
  try {
    raw = fs.readFileSync(headerPath, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s*注入头/.test(line));
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

// ── 时间线格式化（角色的朋友圈记忆） ────────────────────────────

/** 时间线里的动态正文摘要长度：只求"记得大概在聊什么"，不整段复述 */
const TIMELINE_POST_EXCERPT_CHARS = 60;

/** 评论区显示作者名：用户/昔涟用习惯称呼，角色用本名 */
function authorLabel(author: MomentAuthor): string {
  if (author === "user") return "用户";
  if (author === "cyrene") return "昔涟";
  return author;
}

function excerpt(text: string): string {
  const cleaned = text.trim();
  return cleaned.length > TIMELINE_POST_EXCERPT_CHARS
    ? `${cleaned.slice(0, TIMELINE_POST_EXCERPT_CHARS)}…`
    : cleaned;
}

/** 时间线行首时间：M月D日 HH:mm */
function formatTimelineTime(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${formatClock(at)}`;
}

/** 时间线格式化为"连续日记"：旧 → 新，一行动态 + 一行"你做了什么"，他人回复跟在评论后 */
export function formatCharacterTimeline(timeline: CharacterTimeline): string {
  const lines: string[] = [];
  for (const entry of timeline.entries) {
    const at = entry.kind === "comment" ? entry.comment.createdAt : entry.reaction.createdAt;
    const publish = entry.post.title?.trim()
      ? `${authorLabel(entry.post.author)}发布《${entry.post.title.trim()}》`
      : `${authorLabel(entry.post.author)}发布`;
    lines.push(`${formatTimelineTime(at)} ${publish}："${excerpt(entry.post.text)}"`);
    if (entry.kind === "comment") {
      const replies = entry.replies
        .map((reply) => `${authorLabel(reply.author)}回复："${reply.content.trim()}"`)
        .join(" ");
      lines.push(`  你评论了："${entry.comment.content.trim()}"${replies ? ` ${replies}` : ""}`);
    } else {
      lines.push("  你点了赞。");
    }
  }
  if (timeline.truncatedComments > 0) {
    lines.push(`（还有 ${timeline.truncatedComments} 条更早的评论，记不清了）`);
  }
  return lines.join("\n");
}

// ── prompt 组装 ─────────────────────────────────────────────────

/** post_eval 注入最近 12 条评论，更早的标注省略——评论区可以几十条，不设上限会让 prompt 无界膨胀 */
const POST_EVAL_COMMENT_LIMIT = 12;
/** reply_eval 注入当前回复链全量 + 最近 6 条其他评论：回复场景的注意力是"原帖 + 当前线程" */
const REPLY_EVAL_OTHER_COMMENT_LIMIT = 6;

/** 评论行：[时分] 作者（回复某人）：内容 */
function formatCommentLine(comment: MomentComment, byId: Map<string, MomentComment>): string {
  const target = comment.replyTo ? byId.get(comment.replyTo) : undefined;
  const replyMark = target ? `（回复${authorLabel(target.author)}）` : "";
  return `[${formatClock(comment.createdAt)}] ${authorLabel(comment.author)}${replyMark}：${comment.content.trim()}`;
}

/** 按时间正序过滤出可注入的评论（空白内容是删除占位，不注入） */
function visibleComments(comments: readonly MomentComment[]): MomentComment[] {
  return comments
    .filter((comment) => comment.content.trim())
    .sort((a, b) => a.createdAt - b.createdAt);
}

function buildPostEvalCommentBlock(comments: readonly MomentComment[]): string {
  const sorted = visibleComments(comments);
  if (sorted.length === 0) return "暂无";
  const byId = new Map(sorted.map((comment) => [comment.id, comment]));
  const shown = sorted.slice(-POST_EVAL_COMMENT_LIMIT);
  const lines = shown.map((comment) => formatCommentLine(comment, byId));
  if (sorted.length > shown.length) lines.unshift("（更早的评论已省略）");
  return lines.join("\n");
}

/** reply_eval 的评论区：触发评论所在的整条回复链全量 + 最近几条其他评论 */
function buildReplyEvalCommentBlock(comments: readonly MomentComment[], replyTargetId: string): string {
  const sorted = visibleComments(comments);
  const byId = new Map(sorted.map((comment) => [comment.id, comment]));
  const chain = new Set<string>();
  let cursor = byId.get(replyTargetId);
  while (cursor && !chain.has(cursor.id)) {
    chain.add(cursor.id);
    cursor = cursor.replyTo ? byId.get(cursor.replyTo) : undefined;
  }
  const others = sorted
    .filter((comment) => !chain.has(comment.id))
    .slice(-REPLY_EVAL_OTHER_COMMENT_LIMIT);
  const merged = [...others, ...sorted.filter((comment) => chain.has(comment.id))]
    .sort((a, b) => a.createdAt - b.createdAt);
  if (merged.length === 0) return "暂无";
  return merged.map((comment) => formatCommentLine(comment, byId)).join("\n");
}

/** 身份声明永远在最前，随后是共享注入头、角色卡正文、命中的 worldbook 设定 */
function buildCharacterSystem(persona: CharacterPersona, worldbook?: string): string {
  return [
    `你是${persona.nickname}。`,
    persona.headerText,
    persona.personaText,
    worldbook?.trim(),
  ].filter(Boolean).join("\n\n");
}

function buildMemorySection(timeline?: CharacterTimeline | null): string {
  const text = timeline ? formatCharacterTimeline(timeline) : "";
  return [
    "—— 你的朋友圈记忆（最近的互动，更早的可能记不清了）——",
    text || "（你最近没有在朋友圈留下互动）",
  ].join("\n");
}

function buildPostSection(post: MomentPost, viewerNickname?: string): string[] {
  const lines = [`${authorLabel(post.author)}发布了这条动态：`];
  if (post.title?.trim()) lines.push(`标题：${post.title.trim()}`);
  lines.push(`正文：${post.text.trim()}`);
  lines.push(`配图：${post.media.length} 张`);
  // 点名提示：正文里 @ 了正在阅读的角色，回应应当冲着点名来，沉默/答非所问都很失礼
  if (viewerNickname && post.mentions?.includes(viewerNickname)) {
    lines.push(`（${authorLabel(post.author)}在这条动态里 @ 了你）`);
  }
  return lines;
}

export interface CharacterReactionMessagesInput {
  persona: CharacterPersona;
  /** 关键词命中的 worldbook 设定块；空串/缺省不注入 */
  worldbook?: string;
  /** 该角色的朋友圈记忆（store 查询结果）；缺省视为无记忆 */
  timeline?: CharacterTimeline | null;
  post: MomentPost;
  /** 动态带图时转 base64 直发多模态模型 */
  postImages?: readonly MomentPostImage[];
  comments: readonly MomentComment[];
  localNow: Date;
}

/** 角色对动态表态（post_eval）的消息组装 */
export function buildCharacterPostEvalMessages(input: CharacterReactionMessagesInput): ChatMessage[] {
  const { persona } = input;
  const user = [
    buildMemorySection(input.timeline),
    [
      "—— 此刻 ——",
      ...buildPostSection(input.post, persona.nickname),
      "",
      "动态下已有的评论：",
      buildPostEvalCommentBlock(input.comments),
      `当前时间：${formatNow(input.localNow)}`,
      "",
      `以${persona.nickname}的身份判断你的反应，按规定格式输出。`,
      "",
      `请只返回以下一种 JSON，不要使用 Markdown 代码块，也不要添加解释：
{"action":"silent"}
或
{"action":"like"}
或
{"action":"comment","comment":"要留下的评论"}
或
{"action":"like_comment","comment":"要留下的评论"}`,
    ].join("\n"),
  ].join("\n\n");
  return [
    { role: "system", content: buildCharacterSystem(persona, input.worldbook) },
    { role: "user", content: appendImageBlocks(user, input.postImages) },
  ];
}

export interface CharacterReplyEvalMessagesInput extends CharacterReactionMessagesInput {
  /** 触发本次回复的评论 id：它回复了该角色的某条评论 */
  replyTargetId: string;
}

/** 角色被回复后表态（reply_eval）的消息组装：显式给出"你的原评论 + 对方回复"对 */
export function buildCharacterReplyEvalMessages(input: CharacterReplyEvalMessagesInput): ChatMessage[] {
  const { persona } = input;
  const byId = new Map(input.comments.map((comment) => [comment.id, comment]));
  const trigger = byId.get(input.replyTargetId);
  const ownComment = trigger?.replyTo ? byId.get(trigger.replyTo) : undefined;

  // 触发评论已不可见属异常兜底：不猜内容，只告知"有人回复过你"
  const replySection = trigger
    ? [
      "对方刚刚回复了你的这条评论：",
      `你的评论："${ownComment ? ownComment.content.trim() : "（原评论已不存在）"}"`,
      `${authorLabel(trigger.author)}回复："${trigger.content.trim()}"`,
      "你可以选择不回复，或回复一句。",
    ]
    : ["对方刚刚回复了你，但那条评论现在已经看不到了。你可以选择不回复。"];

  const user = [
    buildMemorySection(input.timeline),
    [
      "—— 此刻 ——",
      ...buildPostSection(input.post),
      "",
      ...replySection,
      "",
      "这条动态下的其他评论：",
      buildReplyEvalCommentBlock(input.comments, input.replyTargetId),
      `当前时间：${formatNow(input.localNow)}`,
      "",
      `以${persona.nickname}的身份判断你的反应，按规定格式输出。`,
      "",
      `请只返回以下一种 JSON，不要使用 Markdown 代码块，也不要添加解释：
{"action":"silent"}
或
{"action":"reply","comment":"要发布的回复"}`,
    ].join("\n"),
  ].join("\n\n");
  return [
    { role: "system", content: buildCharacterSystem(persona, input.worldbook) },
    { role: "user", content: appendImageBlocks(user, input.postImages) },
  ];
}

// ── 决策契约与解析 ──────────────────────────────────────────────
// post（对动态表态）与 reply（被回复后表态）语义不同，不共用。
// 解析失败返回 invalid，由调度方统一降级 silent——宁沉默不乱说话，
// 评论文本超长也不自动截断（截断会把一句台词砍成半截）。

export type CharacterPostDecision =
  | { action: "silent" }
  | { action: "like" }
  | { action: "comment"; comment: string }
  | { action: "like_comment"; comment: string };

export type CharacterPostDecisionResult =
  | CharacterPostDecision
  | { action: "invalid"; reason: string };

export type CharacterReplyDecision =
  | { action: "silent" }
  | { action: "reply"; comment: string };

export type CharacterReplyDecisionResult =
  | CharacterReplyDecision
  | { action: "invalid"; reason: string };

/** 校验评论文本：trim 后非空且不超评论长度上限 */
function validateCommentText(raw: unknown): { ok: true; comment: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "empty_comment" };
  const cleaned = raw.trim();
  if (cleaned.length > MOMENT_MAX_COMMENT_TEXT_LENGTH) return { ok: false, reason: "comment_too_long" };
  return { ok: true, comment: cleaned };
}

/** 解析模型原始输出为 JSON 对象；失败时区分非法 JSON 与合法 JSON 但形状不对 */
function parseDecisionObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid_shape" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export function parseCharacterPostDecision(text: string): CharacterPostDecisionResult {
  const parsed = parseDecisionObject(text);
  if (!parsed.ok) return { action: "invalid", reason: parsed.reason };
  const action = typeof parsed.value.action === "string" ? parsed.value.action : undefined;
  switch (action) {
    case "silent":
      return { action: "silent" };
    case "like":
      return { action: "like" };
    case "comment":
    case "like_comment": {
      const comment = validateCommentText(parsed.value.comment);
      if (!comment.ok) return { action: "invalid", reason: comment.reason };
      return { action, comment: comment.comment };
    }
    default:
      return { action: "invalid", reason: "invalid_action" };
  }
}

export function parseCharacterReplyDecision(text: string): CharacterReplyDecisionResult {
  const parsed = parseDecisionObject(text);
  if (!parsed.ok) return { action: "invalid", reason: parsed.reason };
  const action = typeof parsed.value.action === "string" ? parsed.value.action : undefined;
  switch (action) {
    case "silent":
      return { action: "silent" };
    case "reply": {
      const comment = validateCommentText(parsed.value.comment);
      if (!comment.ok) return { action: "invalid", reason: comment.reason };
      return { action: "reply", comment: comment.comment };
    }
    default:
      return { action: "invalid", reason: "invalid_action" };
  }
}
