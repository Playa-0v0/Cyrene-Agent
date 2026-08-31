/**
 * 工具错误分类器（v3 §5.3）
 * 注：注释中的 "v3 §x" / "设计稿 §x" 均指 docs/design/2026-08-08-cyreneHarnessloopdesign.md（CyreneHarness 设计稿 v3）。
 *
 * 把工具执行抛出的 Error / 返回的失败结果分类为 ToolErrorCategory。
 * 分类结果供 retry-policy 决定是否重试。
 */

import type { ToolCallResult } from "../types";
import type { ToolErrorCategory } from "./types";
import { ToolExecutionError } from "../tool-execution-error";

/**
 * 从 Error 对象分类工具错误。
 * 基于明确异常类型，不靠文本模糊匹配。
 */
export function classifyToolError(err: unknown): ToolErrorCategory {
  if (err instanceof ToolExecutionError) return err.category;
  if (!(err instanceof Error)) {
    return "transient";
  }

  const message = err.message;

  // 超时：AbortError 或明确超时消息
  if (err.name === "AbortError") return "timeout";
  if (message.includes("timeout") || message.includes("超时")) return "timeout";

  // 权限
  if (message.includes("permission") || message.includes("权限") || message.includes("EPERM")) {
    return "permission_denied";
  }

  // 文件不存在
  if (message.includes("not found") || message.includes("ENOENT") || message.includes("不存在")) {
    return "not_found";
  }

  // 速率限制
  if (message.includes("rate limit") || message.includes("429") || message.includes("速率")) {
    return "rate_limited";
  }

  // 参数错误
  if (message.includes("invalid argument") || message.includes("参数错误") || message.includes("EINVAL")) {
    return "invalid_arguments";
  }

  // 致命错误（OOM / 崩溃 / 不可恢复）
  if (
    message.includes("fatal") ||
    message.includes("FATAL") ||
    message.includes("ENOMEM") ||
    message.includes("heap out of memory")
  ) {
    return "fatal";
  }

  // 默认：瞬时错误（网络抖动等）
  return "transient";
}

/**
 * 从 ToolCallResult 分类工具错误（工具执行返回失败状态时）。
 */
export function classifyToolResultError(result: ToolCallResult): ToolErrorCategory {
  if (result.category) return result.category;
  const code = result.errorCode ?? "";
  const output = result.output ?? "";

  if (code.includes("TIMEOUT") || output.includes("超时")) return "timeout";
  if (code.includes("PERMISSION") || code.includes("EPERM")) return "permission_denied";
  if (code.includes("NOT_FOUND") || code.includes("ENOENT")) return "not_found";
  if (code.includes("RATE_LIMIT") || code.includes("429")) return "rate_limited";
  if (code.includes("INVALID_ARG") || code.includes("EINVAL")) return "invalid_arguments";
  if (code.includes("FATAL") || code.includes("OOM")) return "fatal";

  // retryable 标记为 true 的通常是瞬时错误
  if (result.retryable) return "transient";

  // 部分失败
  if (result.terminal === false) return "partial_failure";

  // 语义失败（工具执行了但结果不对）
  return "semantic_failure";
}
