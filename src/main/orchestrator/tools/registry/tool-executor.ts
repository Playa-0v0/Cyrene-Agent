import { isAbortError } from "../../../abort-utils";
import type { ToolContext } from "./tool-context";
import type { ToolDefinition } from "./tool-registry";
import { normalizeToolExecutionOutcome } from "./tool-outcome-normalizer";
import {
  ToolExecutionError,
  type ToolEffectState,
  type ToolErrorCategory,
} from "./tool-execution-error";
import type { ToolExecutionOutcome } from "../../types";
import type { PluginToolResult, PluginToolResultContentBlock } from "../../../../plugins/api";

export const MAX_TOOL_RESULT_IMAGES = 4;
export const MAX_TOOL_RESULT_IMAGE_BYTES = 5 * 1024 * 1024;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function normalizedRichResult(result: Exclude<PluginToolResult, string>): {
  output: string;
  content: PluginToolResultContentBlock[];
} {
  if (!Array.isArray(result.content) || result.content.length === 0) {
    throw new ToolExecutionError(
      "E_TOOL_RESULT_EMPTY",
      "富媒体工具结果必须包含至少一个 content block",
      "invalid_arguments",
    );
  }
  const images = result.content.filter((block) => block.type === "image");
  if (images.length > MAX_TOOL_RESULT_IMAGES) {
    throw new ToolExecutionError(
      "E_TOOL_RESULT_IMAGE_LIMIT",
      `富媒体工具结果最多包含 ${MAX_TOOL_RESULT_IMAGES} 张图片`,
      "invalid_arguments",
    );
  }
  for (const block of result.content) {
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new ToolExecutionError(
          "E_TOOL_RESULT_INVALID_TEXT",
          "富媒体工具结果的 text block 必须包含字符串",
          "invalid_arguments",
        );
      }
      continue;
    }
    if (!IMAGE_MIME_TYPES.has(block.mimeType)) {
      throw new ToolExecutionError(
        "E_TOOL_RESULT_INVALID_IMAGE_TYPE",
        "富媒体工具结果包含不支持的图片类型",
        "invalid_arguments",
      );
    }
    if (typeof block.data !== "string" || block.data.length === 0 || !BASE64_RE.test(block.data)) {
      throw new ToolExecutionError(
        "E_TOOL_RESULT_INVALID_IMAGE",
        "富媒体工具结果的图片必须是合法 base64",
        "invalid_arguments",
      );
    }
    const bytes = Buffer.byteLength(block.data, "base64");
    if (bytes > MAX_TOOL_RESULT_IMAGE_BYTES) {
      throw new ToolExecutionError(
        "E_TOOL_RESULT_IMAGE_TOO_LARGE",
        `单张工具结果图片不能超过 ${MAX_TOOL_RESULT_IMAGE_BYTES} bytes`,
        "invalid_arguments",
      );
    }
  }
  const text = result.content
    .filter((block): block is Extract<PluginToolResultContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return {
    output: text || `[工具返回 ${images.length} 张图片]`,
    content: result.content.map((block) => ({ ...block })),
  };
}

function isCategory(value: unknown): value is ToolErrorCategory {
  return typeof value === "string" && [
    "transient", "timeout", "rate_limited", "not_found", "permission_denied",
    "invalid_arguments", "semantic_failure", "partial_failure", "fatal", "runtime_safety",
  ].includes(value);
}

function effectState(value: unknown): ToolEffectState {
  return value === "unknown" ? "unknown" : "not_applied";
}

function legacyFailure(output: string): ToolExecutionOutcome | undefined {
  const trimmed = output.trimStart();
  if (trimmed.startsWith("[错误]")) {
    return {
      status: "failed",
      output,
      errorCode: "E_LEGACY_TOOL_ERROR",
      category: "semantic_failure",
      effectState: "not_applied",
    };
  }
  if (trimmed.startsWith("[拒绝]")) {
    return {
      status: "failed",
      output,
      errorCode: "E_LEGACY_TOOL_REJECTED",
      category: "permission_denied",
      effectState: "not_applied",
    };
  }

  try {
    const parsed = JSON.parse(output) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (parsed.timedOut === true) {
      return {
        status: "failed",
        output,
        errorCode: "E_TOOL_TIMEOUT",
        category: "timeout",
        retryable: false,
        effectState: "unknown",
      };
    }
    if (parsed.success !== false) return undefined;
    const message = typeof parsed.error === "string"
      ? parsed.error
      : parsed.error === undefined ? "工具执行失败" : JSON.stringify(parsed.error);
    return {
      status: "failed",
      output: message,
      errorCode: typeof parsed.errorCode === "string" ? parsed.errorCode : "E_TOOL_BUSINESS_FAILED",
      category: isCategory(parsed.category) ? parsed.category : "semantic_failure",
      retryable: parsed.retryable === true,
      effectState: effectState(parsed.effectState),
    };
  } catch {
    return undefined;
  }
}

/**
 * Single execution boundary for registered tools.
 *
 * The legacy return-value compatibility is temporary. It recognizes only an
 * explicit `success:false` JSON payload or a leading `[错误]` / `[拒绝]` marker.
 */
export async function executeToolDefinition(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ReturnType<typeof normalizeToolExecutionOutcome>> {
  try {
    const returned = await tool.execute(args, context);
    const normalized = typeof returned === "string"
      ? { output: returned, content: undefined }
      : normalizedRichResult(returned);
    const { output } = normalized;
    const legacy = legacyFailure(output);
    return normalizeToolExecutionOutcome(legacy ?? {
      status: "succeeded",
      output,
      ...(normalized.content ? { content: normalized.content } : {}),
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof ToolExecutionError) {
      return normalizeToolExecutionOutcome({
        status: "failed",
        output: error.message,
        errorCode: error.code,
        category: error.category,
        retryable: error.retryable,
        effectState: error.effectState,
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    const explicitCode = typeof error === "object" && error !== null && "code" in error
      && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : undefined;
    return normalizeToolExecutionOutcome({
      status: "failed",
      output: message,
      errorCode: explicitCode ?? "E_TOOL_EXECUTION_FAILED",
      effectState: "not_applied",
    });
  }
}
