/**
 * 副作用解析器（v3 §5.2）
 * 注：注释中的 "v3 §x" / "设计稿 §x" 均指 docs/design/2026-08-08-cyreneHarnessloopdesign.md（CyreneHarness 设计稿 v3）。
 *
 * 把现有 ToolDefinition.effectKind / effectResolver 映射到 Harness 的 SideEffectKind。
 * 现有 effectKind: read / mutation / verification / external_side_effect / unknown
 * Harness SideEffectKind: read_only / idempotent_mutation / non_idempotent_side_effect
 */

import type { ToolDefinition } from "../tool-registry";
import { resolveEffectKind } from "../tool-registry";
import type { SideEffectKind } from "./types";

/** 静态映射表：旧 effectKind → 新 SideEffectKind */
const EFFECT_KIND_MAP: Record<string, SideEffectKind> = {
  read: "read_only",
  verification: "read_only",
  mutation: "idempotent_mutation",
  external_side_effect: "non_idempotent_side_effect",
  unknown: "read_only", // 保守默认
};

/**
 * 解析工具调用的副作用分类。
 * 优先使用 tool.effectResolver（动态），其次 tool.effectKind（静态），默认 read_only。
 */
export function resolveSideEffect(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown>,
): SideEffectKind {
  const effectKind = resolveEffectKind(tool, args);
  return EFFECT_KIND_MAP[effectKind] ?? "read_only";
}
