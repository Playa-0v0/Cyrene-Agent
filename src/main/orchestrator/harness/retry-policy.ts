/**
 * 重试策略（v3 §5.3 / §5.4）
 * 注：注释中的 "v3 §x" / "设计稿 §x" 均指 docs/design/2026-08-08-cyreneHarnessloopdesign.md（CyreneHarness 设计稿 v3）。
 *
 * 根据 error category + side-effect 决定是否重试，以及重试参数。
 * 核心原则：不让 LLM 决定"要不要重试"——这是代码的活。
 */

import type { ToolErrorCategory, RetryDecision, SideEffectKind } from "./types";
import { createAbortError } from "../../abort-utils";

/** 重试参数 */
export interface RetryParams {
  maxRetries: number;
  backoffMs: number[];
}

/**
 * 决定是否重试（v3 §5.3 决策表）。
 *
 * @param category 错误分类
 * @param sideEffect 副作用分类
 * @returns "retry" 或 "no_retry"
 */
export function decideRetry(
  category: ToolErrorCategory,
  sideEffect: SideEffectKind,
): RetryDecision {
  // fatal 永不重试
  if (category === "fatal") return "no_retry";

  // runtime_safety 永不重试（fingerprint 拦截等）
  if (category === "runtime_safety") return "no_retry";

  // non_idempotent_side_effect 任何 category 都不自动重试
  if (sideEffect === "non_idempotent_side_effect") return "no_retry";

  switch (sideEffect) {
    case "read_only":
      // read_only: transient / timeout / rate_limited 重试
      if (category === "transient" || category === "timeout" || category === "rate_limited") {
        return "retry";
      }
      // unknown 最多 1 次重试（保守）
      if (category === "partial_failure") return "retry";
      // not_found / permission_denied / invalid_arguments / semantic_failure 不重试
      return "no_retry";

    case "idempotent_mutation":
      // idempotent: transient / timeout / rate_limited 重试
      if (category === "transient" || category === "timeout" || category === "rate_limited") {
        return "retry";
      }
      // 其余不重试
      return "no_retry";

    default:
      return "no_retry";
  }
}

/**
 * 获取重试参数（v3 §5.4 退避策略）。
 */
export function getRetryParams(category: ToolErrorCategory): RetryParams {
  switch (category) {
    case "transient":
      return { maxRetries: 3, backoffMs: [500, 1000, 2000] };

    case "timeout":
      return { maxRetries: 2, backoffMs: [1000, 3000] };

    case "rate_limited":
      return { maxRetries: 2, backoffMs: [2000, 5000] };

    default:
      return { maxRetries: 0, backoffMs: [] };
  }
}

/** 带抖动的退避等待 */
export function sleepWithJitter(ms: number, signal?: AbortSignal): Promise<void> {
  const jitter = Math.random() * ms * 0.3;
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms + jitter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
