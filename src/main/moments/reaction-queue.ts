// 朋友圈反应队列：延迟表态任务的持久化与到期执行。
//
// 职责边界：
// - 只管"什么时候执行"与"崩溃后怎么续"：去重入队、到期扫描、决策缓存、失败退避；
//   "决策怎么产生、副作用怎么落库"全部委托给注入的执行器（昔涟与角色各自的执行器由 service 装配）；
// - 持久化独立文件（与 moments.json / moments-state.json 分离）：任务入队即落盘，
//   执行成功才删除——执行中途崩溃，重启后任务还在，凭评论通道的 sourceTaskId 幂等续接；
// - 决策幂等：模型返回合法决策后先把 resolvedDecision 落盘、再执行副作用，
//   崩溃恢复时直接执行原决策、不再调模型——模型不是确定性的，重问一次
//   "重抽人格"会让第一次说"练得不错"的角色重启后变成沉默，只留下孤儿点赞；
// - 扫描器 single-flight：模型调用完全可能超过扫描周期，排空循环用 draining
//   标志防重入——store 幂等挡得住重复写入，但重复执行会把模型的钱烧两遍。

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ── 任务与决策类型 ──────────────────────────────────────────────

export type ReactionTaskKind =
  | "post_eval"   // 对动态表态（走模型，输出沉默/赞/评/赞+评）
  | "reply_eval"  // 被回复后表态（走模型，输出沉默/回复）
  | "auto_like";  // 纯随机点赞（不走模型，到期直接落库）

export interface ReactionTask {
  id: string;
  kind: ReactionTaskKind;
  /** 昔涟（"cyrene"）或角色名 */
  actor: string;
  postId: string;
  /** reply_eval 时：触发本次回复的评论 id（参与去重键，不同评论的回复任务互不去重） */
  triggerCommentId?: string;
  /** 用户在这条动态里 @ 了该动作者：直达任务（绕过抽签与双骰），prompt 会感知点名 */
  mentioned?: boolean;
  /** 到期执行时间 */
  dueAt: number;
  /** 供应商失败计数（退避重试用） */
  attempts: number;
  /** 模型已定决策缓存：存在时直接执行该决策，不再调模型 */
  resolvedDecision?: ReactionDecision;
}

/**
 * 队列内缓存与执行的统一决策形态：对动态表态与被回复后表态两套契约的并集，
 * 全部可 JSON 序列化。silent 无副作用，由队列跳过落库。
 */
export type ReactionDecision =
  | { action: "silent" }
  | { action: "like" }
  | { action: "comment"; comment: string }
  | { action: "like_comment"; comment: string }
  | { action: "reply"; comment: string };

/** 决策阶段结果：三类失败语义不同，不能混用一种处理。 */
export type ReactionDecideOutcome =
  | { type: "decided"; decision: ReactionDecision }
  /** 模型成功但输出非法 / 评论超长：决策已完成，降级 silent 后删任务，不重试 */
  | { type: "invalid"; reason: string }
  /** 供应商错误（超时/5xx/限流/断网）：基础设施失败，值得退避重试 */
  | { type: "retry"; reason: string }
  /** 目标已删 / 开关关闭 / 模型未配置：世界已变，任务作废 */
  | { type: "stale"; reason: string };

export interface ReactionTaskExecutor {
  /**
   * 决策阶段：执行前复核目标存在性与开关、调模型产出表态决策。
   * auto_like 任务不走此阶段（零模型成本）。
   */
  decide(task: ReactionTask): Promise<ReactionDecideOutcome>;
  /** 副作用阶段：把决策落库为点赞/评论；store 幂等吸收崩溃窗口内的重放 */
  apply(task: ReactionTask, decision: ReactionDecision): Promise<void>;
}

// ── 延迟计算 ────────────────────────────────────────────────────
// 真人刷社交媒体是首波密集、长尾稀疏：延迟按桶分布抽签、桶内均匀。
// 不用全区间均匀——均匀意味着"3 分钟后"和"2 小时 57 分后"等概率，不像人。

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

interface DelayBucket {
  /** 组内相对权重（占比按权重归一） */
  weight: number;
  minMs: number;
  maxMs: number;
}

/** 抽桶（按权重）后桶内均匀取值 */
function pickBucketDelay(buckets: readonly DelayBucket[], random: () => number): number {
  const total = buckets.reduce((sum, bucket) => sum + bucket.weight, 0);
  let roll = random() * total;
  for (const bucket of buckets) {
    roll -= bucket.weight;
    if (roll < 0) {
      return bucket.minMs + Math.floor(random() * (bucket.maxMs - bucket.minMs));
    }
  }
  return buckets[buckets.length - 1].minMs;
}

/** 角色对动态表态（含纯随机点赞——秒赞同样穿帮，延迟是拟人感的来源） */
const CHARACTER_POST_BUCKETS: readonly DelayBucket[] = [
  { weight: 50, minMs: 3 * MINUTE_MS, maxMs: 20 * MINUTE_MS },
  { weight: 30, minMs: 20 * MINUTE_MS, maxMs: 60 * MINUTE_MS },
  { weight: 15, minMs: 60 * MINUTE_MS, maxMs: 2 * HOUR_MS },
  { weight: 5, minMs: 2 * HOUR_MS, maxMs: 4 * HOUR_MS },
];

/** 角色被回复后的回应：整体比表态快，但同样长尾 */
const CHARACTER_REPLY_BUCKETS: readonly DelayBucket[] = [
  { weight: 50, minMs: 5 * MINUTE_MS, maxMs: 15 * MINUTE_MS },
  { weight: 30, minMs: 15 * MINUTE_MS, maxMs: 40 * MINUTE_MS },
  { weight: 20, minMs: 40 * MINUTE_MS, maxMs: 60 * MINUTE_MS },
];

/** 昔涟表态：在线 1~8 分钟；离线 1~40 分钟（她和用户关系最好，看到就会回应，不拖长尾） */
const CYRENE_POST_OFFLINE_BUCKETS: readonly DelayBucket[] = [
  { weight: 50, minMs: 1 * MINUTE_MS, maxMs: 10 * MINUTE_MS },
  { weight: 30, minMs: 10 * MINUTE_MS, maxMs: 25 * MINUTE_MS },
  { weight: 15, minMs: 25 * MINUTE_MS, maxMs: 35 * MINUTE_MS },
  { weight: 5, minMs: 35 * MINUTE_MS, maxMs: 40 * MINUTE_MS },
];

/** 昔涟回复：在线 1~5 分钟；离线 1~40 分钟（整体比表态偏快，被回复后她会尽快接话） */
const CYRENE_REPLY_OFFLINE_BUCKETS: readonly DelayBucket[] = [
  { weight: 50, minMs: 1 * MINUTE_MS, maxMs: 8 * MINUTE_MS },
  { weight: 30, minMs: 8 * MINUTE_MS, maxMs: 20 * MINUTE_MS },
  { weight: 15, minMs: 20 * MINUTE_MS, maxMs: 32 * MINUTE_MS },
  { weight: 5, minMs: 32 * MINUTE_MS, maxMs: 40 * MINUTE_MS },
];

/** 被 @ 点名的秒回档：30 秒 ~ 3 分钟——"刚好在看手机"的节奏。
 *  不是 0 秒（那是机器人），用户点名 = 在等回应，来得要比自然刷到快得多。 */
const MENTION_BUCKETS: readonly DelayBucket[] = [
  { weight: 60, minMs: 30_000, maxMs: 90_000 },
  { weight: 30, minMs: 90_000, maxMs: 3 * MINUTE_MS },
  { weight: 10, minMs: 3 * MINUTE_MS, maxMs: 5 * MINUTE_MS },
];

export function computeCharacterPostDelayMs(random: () => number): number {
  return pickBucketDelay(CHARACTER_POST_BUCKETS, random);
}

export function computeCharacterReplyDelayMs(random: () => number): number {
  return pickBucketDelay(CHARACTER_REPLY_BUCKETS, random);
}

export function computeCyrenePostDelayMs(online: boolean, random: () => number): number {
  if (online) return MINUTE_MS + Math.floor(random() * 7 * MINUTE_MS);
  return pickBucketDelay(CYRENE_POST_OFFLINE_BUCKETS, random);
}

export function computeCyreneReplyDelayMs(online: boolean, random: () => number): number {
  if (online) return MINUTE_MS + Math.floor(random() * 4 * MINUTE_MS);
  return pickBucketDelay(CYRENE_REPLY_OFFLINE_BUCKETS, random);
}

/** 被 @ 点名的回应延迟：秒回档。调用方不套深夜窗口——用户半夜点名，说明醒着在等。 */
export function computeMentionDelayMs(random: () => number): number {
  return pickBucketDelay(MENTION_BUCKETS, random);
}

// 深夜窗口：[01:00, 07:00) 本地时间入队的任务推迟到当日 08:00 + 随机 0~120 分钟，
// 直接替代正常延迟（不叠加——叠加会把"早上刷到"拖到中午）。
const NIGHT_WINDOW_START_HOUR = 1;
const NIGHT_WINDOW_END_HOUR = 7;
const NIGHT_WINDOW_BASE_HOUR = 8;
const NIGHT_WINDOW_SPREAD_MS = 120 * MINUTE_MS;

/**
 * 深夜窗口校正：入队时刻在凌晨 1~7 点之间时，把 dueAt 替换为当日
 * 08:00 起随机 0~120 分钟；窗口外原样返回。昔涟在线短延迟由调用方跳过本校正
 * （用户凌晨三点正和昔涟聊天，她就是醒着的）。
 */
export function applyNightWindow(dueAt: number, now: Date, random: () => number): number {
  const hour = now.getHours();
  if (hour < NIGHT_WINDOW_START_HOUR || hour >= NIGHT_WINDOW_END_HOUR) return dueAt;
  const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), NIGHT_WINDOW_BASE_HOUR, 0, 0, 0);
  return morning.getTime() + Math.floor(random() * NIGHT_WINDOW_SPREAD_MS);
}

// ── 队列本体 ────────────────────────────────────────────────────

/** 供应商失败的退避梯度：累计退避满三次（5/15/30 分钟）仍失败则放弃任务 */
const RETRY_BACKOFF_MS = [5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS];

/** 扫描周期：30 秒一轮，配合 single-flight 标志防重入 */
const DEFAULT_SCAN_INTERVAL_MS = 30_000;

export interface EnqueueReactionInput {
  kind: ReactionTaskKind;
  actor: string;
  postId: string;
  triggerCommentId?: string;
  /** 用户在这条动态里 @ 了该动作者：任务为点名直达，prompt 会感知 */
  mentioned?: boolean;
  /** 到期时间（调用方用延迟函数算好）；缺省立即到期 */
  dueAt?: number;
}

export interface ReactionQueueDeps {
  /**
   * 持久化文件路径。传函数可延迟解析——service 在 import 期构造，
   * 此时生产环境的 userData 路径还不该被触碰。
   */
  filePath: string | (() => string);
  executor: ReactionTaskExecutor;
  now?: () => number;
  /** 扫描周期（缺省 30 秒；测试可调小） */
  scanIntervalMs?: number;
  log?: (event: string, detail?: unknown) => void;
}

export interface ReactionQueue {
  /** 入队（同去重键的未完成任务已存在时返回 null）；立即落盘 */
  enqueue(input: EnqueueReactionInput): ReactionTask | null;
  /** 取消某动作者在某动态下的全部待执行任务，返回取消条数 */
  cancelTasks(input: { actor: string; postId: string }): number;
  /** 当前任务快照（诊断与测试用） */
  list(): ReactionTask[];
  /** 手动扫描一轮到期任务；已有排空在进行时返回 false（single-flight） */
  drainOnce(): Promise<boolean>;
  /** 启动周期扫描器（启动即补扫一轮，重启后逾期任务尽快续上） */
  start(): void;
  /** 停止扫描器 */
  stop(): void;
}

/**
 * 去重键：post / reply / like 三种语义互不相同。
 * reply_eval 必须带上 triggerCommentId——用户先后回复同一角色的两条不同评论时，
 * 缺了它第二次回复会被误去重丢弃。
 */
function buildDedupeKey(kind: ReactionTaskKind, actor: string, postId: string, triggerCommentId?: string): string {
  if (kind === "reply_eval") return `${actor}:${postId}:reply:${triggerCommentId ?? ""}`;
  if (kind === "auto_like") return `${actor}:${postId}:like`;
  return `${actor}:${postId}:post`;
}

/** 磁盘读入时的形状校验：损坏或旧结构的条目直接丢弃，不阻断加载 */
function isValidTask(value: unknown): value is ReactionTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<ReactionTask>;
  return (
    typeof task.id === "string" &&
    (task.kind === "post_eval" || task.kind === "reply_eval" || task.kind === "auto_like") &&
    typeof task.actor === "string" &&
    typeof task.postId === "string" &&
    typeof task.dueAt === "number" &&
    typeof task.attempts === "number" &&
    (task.triggerCommentId === undefined || typeof task.triggerCommentId === "string") &&
    (task.resolvedDecision === undefined || isValidDecision(task.resolvedDecision))
  );
}

function isValidDecision(value: unknown): value is ReactionDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as { action?: unknown; comment?: unknown };
  switch (decision.action) {
    case "silent":
    case "like":
      return true;
    case "comment":
    case "like_comment":
    case "reply":
      return typeof decision.comment === "string";
    default:
      return false;
  }
}

export function createReactionQueue(deps: ReactionQueueDeps): ReactionQueue {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const scanIntervalMs = deps.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;

  // 惰性加载：首次入队/扫描才读盘。service 在 import 期构造队列，
  // 那一刻不该有磁盘副作用；真正的"启动加载"发生在扫描器首轮补扫。
  let tasks: ReactionTask[] | null = null;
  let resolvedPath: string | null = null;
  let draining = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function filePath(): string {
    if (resolvedPath === null) {
      resolvedPath = typeof deps.filePath === "function" ? deps.filePath() : deps.filePath;
    }
    return resolvedPath;
  }

  function ensureLoaded(): void {
    if (tasks !== null) return;
    tasks = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8")) as { tasks?: unknown };
      if (Array.isArray(parsed.tasks)) {
        tasks = parsed.tasks.filter(isValidTask);
        const dropped = parsed.tasks.length - tasks.length;
        if (dropped > 0) log("reaction_queue_invalid_tasks_dropped", dropped);
      }
    } catch (error) {
      // 文件不存在是正常首发；损坏则从空队列开始，不阻断功能
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("reaction_queue_load_failed", String(error));
      }
    }
  }

  /** 原子落盘：.tmp + rename，崩溃时不留半个文件 */
  function persist(): void {
    const target = filePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ tasks }, null, 2), "utf8");
    fs.renameSync(tmp, target);
  }

  function removeTask(taskId: string): void {
    const index = tasks!.findIndex((task) => task.id === taskId);
    if (index >= 0) {
      tasks!.splice(index, 1);
      persist();
    }
  }

  async function applyAndRemove(task: ReactionTask, decision: ReactionDecision): Promise<void> {
    try {
      // silent 无副作用，跳过落库；其余决策由执行器提交
      if (decision.action !== "silent") {
        await deps.executor.apply(task, decision);
      }
      removeTask(task.id);
    } catch (error) {
      log("reaction_apply_failed", { taskId: task.id, actor: task.actor, error: String(error) });
      // 决策已落盘：保留任务，下轮扫描直接重放该决策（store 幂等吸收重复写入）
    }
  }

  async function execute(task: ReactionTask): Promise<void> {
    // 纯随机点赞零模型成本：到期复核后直接落库，点赞唯一性天然幂等
    if (task.kind === "auto_like") {
      await applyAndRemove(task, { action: "like" });
      return;
    }

    // 崩溃恢复：决策已定则直接执行，不再调模型
    if (task.resolvedDecision) {
      await applyAndRemove(task, task.resolvedDecision);
      return;
    }

    let outcome: ReactionDecideOutcome;
    try {
      outcome = await deps.executor.decide(task);
    } catch (error) {
      // 执行器异常按供应商失败处理：退避重试，避免单次抖动丢任务
      log("reaction_decide_error", { taskId: task.id, actor: task.actor, error: String(error) });
      outcome = { type: "retry", reason: String(error) };
    }

    switch (outcome.type) {
      case "decided": {
        // 先落盘决策再执行副作用：崩在两者之间，重启后从"执行"续起，不重问模型
        task.resolvedDecision = outcome.decision;
        persist();
        await applyAndRemove(task, outcome.decision);
        return;
      }
      case "invalid": {
        // 模型成功但输出不可用：决策视作完成，降级 silent 落盘后删任务，不重试
        task.resolvedDecision = { action: "silent" };
        persist();
        removeTask(task.id);
        log("reaction_decision_invalid", { taskId: task.id, actor: task.actor, reason: outcome.reason });
        return;
      }
      case "retry": {
        task.attempts += 1;
        const backoffIndex = task.attempts - 1;
        if (backoffIndex >= RETRY_BACKOFF_MS.length) {
          removeTask(task.id);
          log("reaction_task_abandoned", { taskId: task.id, actor: task.actor, attempts: task.attempts, reason: outcome.reason });
          return;
        }
        task.dueAt = now() + RETRY_BACKOFF_MS[backoffIndex];
        persist();
        log("reaction_task_retry", { taskId: task.id, actor: task.actor, attempts: task.attempts, reason: outcome.reason });
        return;
      }
      case "stale": {
        removeTask(task.id);
        log("reaction_task_stale", { taskId: task.id, actor: task.actor, reason: outcome.reason });
        return;
      }
    }
  }

  /** 排空一轮到期任务；防重入：模型调用可能超过扫描周期，上一轮没排空时本轮直接让位 */
  async function drainOnce(): Promise<boolean> {
    if (draining) return false;
    draining = true;
    try {
      ensureLoaded();
      const due = tasks!
        .filter((task) => task.dueAt <= now())
        .sort((a, b) => a.dueAt - b.dueAt);
      // 扫描时刻的到期快照逐条执行；执行期间新入队的任务（延迟都在未来）留给下一轮
      for (const task of due) {
        await execute(task);
      }
      return true;
    } finally {
      draining = false;
    }
  }

  return {
    enqueue(input) {
      ensureLoaded();
      const key = buildDedupeKey(input.kind, input.actor, input.postId, input.triggerCommentId);
      if (tasks!.some((task) => buildDedupeKey(task.kind, task.actor, task.postId, task.triggerCommentId) === key)) {
        return null;
      }
      const task: ReactionTask = {
        id: `task_${now()}_${randomUUID().slice(0, 8)}`,
        kind: input.kind,
        actor: input.actor,
        postId: input.postId,
        triggerCommentId: input.triggerCommentId,
        mentioned: input.mentioned,
        dueAt: input.dueAt ?? now(),
        attempts: 0,
      };
      tasks!.push(task);
      persist();
      return { ...task };
    },

    /**
     * 取消某动作者在某动态下的全部待执行任务：昔涟在聊天里手动互动后调用，
     * 防止自动表态任务到期后冒出第二条重复评论。返回取消条数供日志。
     */
    cancelTasks(input: { actor: string; postId: string }): number {
      ensureLoaded();
      const before = tasks!.length;
      tasks = tasks!.filter((task) => !(task.actor === input.actor && task.postId === input.postId));
      const cancelled = before - tasks.length;
      if (cancelled > 0) persist();
      return cancelled;
    },

    list() {
      ensureLoaded();
      return tasks!.map((task) => ({ ...task }));
    },

    drainOnce,

    start() {
      if (timer !== null) return;
      const runDrain = () => {
        void drainOnce().catch((error: unknown) => log("reaction_drain_failed", String(error)));
      };
      timer = setInterval(runDrain, scanIntervalMs);
      // 启动即补扫一轮：重启后已逾期的任务尽快续上，不等第一个周期
      runDrain();
    },

    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
