// Moments 主动发帖的策略闸门。
//
// 与 Chat proactive 的分工：proactive 管"打断用户"的打扰预算，
// Moments 管"被动存在感"的存在感预算——朋友圈躺在 Feed 里，不弹通知，
// 无夜间禁发、无 unansweredCount 拦截，两套预算互不共享。
//
// 规则闸门放在 LLM 之前：冷却 / 日上限 / run 粒度去重全部命中后才进入生成，
// 省 token。去重键粒度是 run 不是 conversation：
// 一个会话里上午发包、晚上修 bug 是两件事，按会话去重会误杀第二件。

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { app } from "electron";

// ── 常量 ────────────────────────────────────────────────────────

/** 同一草稿的最小发帖间隔：6 小时冷却 */
export const MIN_POST_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 每日发帖上限（是上限不是配额，允许 0/1/2 条） */
export const MAX_POSTS_PER_DAY = 2;
/** 昔涟生成动态的文案长度上限（用户输入的 2000 上限是另一层，不混用） */
export const MOMENTS_CYRENE_POST_TEXT_MAX = 300;
/** 去重键 FIFO 容量 */
export const RECENT_EVENT_KEYS_CAPACITY = 64;

// ── 状态 ────────────────────────────────────────────────────────

export interface MomentsPolicyState {
  lastPostAt: number | null;
  /** 按本地日期滚动的当日计数 */
  postsToday: { date: string; count: number };
  /** 已发事件的去重键（run 粒度，容量 64 FIFO 淘汰） */
  recentEventKeys: string[];
}

export function defaultMomentsPolicyState(): MomentsPolicyState {
  return { lastPostAt: null, postsToday: { date: "", count: 0 }, recentEventKeys: [] };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地日期键（YYYY-MM-DD），供 postsToday 滚动判定。 */
export function localDateKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ── 规则闸门（LLM 之前） ─────────────────────────────────────────

export type MomentsPostGate =
  | { ok: true }
  | { ok: false; reason: "cooldown" | "daily_limit" };

/** 冷却与日上限判定；不包含任何时段禁发 / 未回复拦截类条件。 */
export function canPost(state: MomentsPolicyState, now: number): MomentsPostGate {
  if (state.lastPostAt !== null && now - state.lastPostAt < MIN_POST_INTERVAL_MS) {
    return { ok: false, reason: "cooldown" };
  }
  if (state.postsToday.date === localDateKey(now) && state.postsToday.count >= MAX_POSTS_PER_DAY) {
    return { ok: false, reason: "daily_limit" };
  }
  return { ok: true };
}

// ── 去重键（run 粒度） ──────────────────────────────────────────

export interface MomentsEventKeyInput {
  conversationId: string;
  runId?: string;
  userText: string;
  assistantReply: string;
}

/**
 * 有 runId 用 runId（一 run 一键）；渠道侧收尾不携带 runId，
 * 兜底用内容哈希——同会话同文本的重复交互本就无新增记录价值。
 */
export function buildMomentsEventKey(input: MomentsEventKeyInput): string {
  if (input.runId) return `conversation_finished:${input.runId}`;
  const digest = createHash("sha256")
    .update(`${input.conversationId}\n${input.userText}\n${input.assistantReply}`)
    .digest("hex")
    .slice(0, 16);
  return `conversation_finished:${digest}`;
}

/** 追加去重键并按容量 FIFO 淘汰最旧的（调用方需先查重）。 */
export function recordEventKey(state: MomentsPolicyState, key: string): MomentsPolicyState {
  const keys = [...state.recentEventKeys, key];
  return { ...state, recentEventKeys: keys.slice(-RECENT_EVENT_KEYS_CAPACITY) };
}

// ── 发帖记账 ─────────────────────────────────────────────────────

/** 发帖成功后记账：刷新冷却起点并滚动当日计数。 */
export function recordPost(state: MomentsPolicyState, now: number): MomentsPolicyState {
  const date = localDateKey(now);
  const count = state.postsToday.date === date ? state.postsToday.count + 1 : 1;
  return { ...state, lastPostAt: now, postsToday: { date, count } };
}

// ── 持久化（moments-state.json，照 proactive-state-store 模式） ───

function getStatePath(): string {
  return path.join(app.getPath("userData"), "moments-state.json");
}

export function loadMomentsPolicyState(): MomentsPolicyState {
  try {
    const p = getStatePath();
    if (!fs.existsSync(p)) return defaultMomentsPolicyState();
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<MomentsPolicyState>;
    const base = defaultMomentsPolicyState();
    return {
      ...base,
      ...raw,
      postsToday: { ...base.postsToday, ...(raw.postsToday ?? {}) },
      recentEventKeys: Array.isArray(raw.recentEventKeys) ? raw.recentEventKeys : [],
    };
  } catch {
    return defaultMomentsPolicyState();
  }
}

export function saveMomentsPolicyState(state: MomentsPolicyState): void {
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("[Moments] save policy state failed:", err);
  }
}