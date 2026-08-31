/**
 * 模型请求超时统一配置模块
 *
 * 唯一规则来源：所有非流式 Structured Output 调用（Task Router、Planner、
 * Native FC、Memory 等）的超时配置统一从本模块获取。
 *
 * 数据流：
 *   用户设置 → resolveModelRequestTimeoutMs() → WorkLoop 启动时解析一次 → 通过 deps 传给各节点
 *
 * 各节点不得：
 * - 自己读取设置存储
 * - 自己处理秒与毫秒转换
 * - 自己限制最小值和最大值
 * - 再写 5000、7000、10000 等模型请求超时常量
 * - 直接 import 默认值后绕过用户配置
 */

// ── 常量 ──────────────────────────────────────────────────

/** 默认模型请求超时（毫秒）：60 秒 */
export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 60_000;

/** 最小模型请求超时（毫秒）：10 秒 */
export const MIN_MODEL_REQUEST_TIMEOUT_MS = 10_000;

/** 最大模型请求超时（毫秒）：10 分钟 */
export const MAX_MODEL_REQUEST_TIMEOUT_MS = 600_000;

// ── 工具函数 ──────────────────────────────────────────────

/**
 * 校验并规范化模型请求超时值。
 * 将用户输入限制在 [MIN, MAX] 范围内，非法值回退到默认值。
 */
export function normalizeModelRequestTimeoutMs(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
  return Math.max(MIN_MODEL_REQUEST_TIMEOUT_MS, Math.min(MAX_MODEL_REQUEST_TIMEOUT_MS, Math.round(num)));
}

/**
 * 从用户设置解析模型请求超时（毫秒）。
 * 用户设置以秒为单位存储，需要转换为毫秒。
 */
export function resolveModelRequestTimeoutMs(userSettings?: { modelRequestTimeoutSec?: number }): number {
  if (!userSettings?.modelRequestTimeoutSec) return DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
  const ms = userSettings.modelRequestTimeoutSec * 1000;
  return normalizeModelRequestTimeoutMs(ms);
}

/**
 * 计算 Structured Output 总预算。
 * 总预算 = 单次超时 × 最大尝试次数。
 */
export function resolveTotalBudgetMs(requestTimeoutMs: number, maxAttempts: number): number {
  return requestTimeoutMs * Math.max(1, maxAttempts);
}

// ── 类型 ──────────────────────────────────────────────────

/** 用户设置中的模型请求超时配置（秒） */
export interface ModelTimeoutSettings {
  modelRequestTimeoutSec?: number;
}

/** 解析后的模型请求超时配置（毫秒） */
export interface ResolvedModelTimeout {
  /** 单次请求超时（毫秒） */
  perAttemptTimeoutMs: number;
  /** 总预算（毫秒） */
  totalBudgetMs: number;
}

/**
 * 一次性解析模型请求超时配置。
 * 在 WorkLoop 启动时调用一次，结果通过 deps 传给各节点。
 */
export function resolveModelTimeout(
  userSettings: ModelTimeoutSettings | undefined,
  maxAttempts: number,
): ResolvedModelTimeout {
  const perAttemptTimeoutMs = resolveModelRequestTimeoutMs(userSettings);
  const totalBudgetMs = resolveTotalBudgetMs(perAttemptTimeoutMs, maxAttempts);
  return { perAttemptTimeoutMs, totalBudgetMs };
}
