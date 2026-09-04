import type { CyreneRunTerminalResult } from "../../../../shared/run-terminal";

/**
 * Harness 结束原因到旧 AgentLoop 结果和标准终态（canonical terminal）的纯映射。
 * 本模块不写 store、不发送事件，也不做 Review 收尾；副作用统一留在编排层。
 */
export type HarnessTerminateReason = "max_rounds" | "timeout" | "cancelled" | "error" | undefined;

export function mapTerminateReason(
  reason: HarnessTerminateReason,
): "no_tool" | "timeout" | "max_rounds" | "tool_error" {
  switch (reason) {
    case "max_rounds":
      return "max_rounds";
    case "timeout":
      return "timeout";
    case "error":
      return "tool_error";
    default:
      // cancelled/undefined 在旧 completionReason 协议中都表示“没有工具结果”；
      // 取消的语义由 mapTerminateReasonToTerminal 单独保留。
      return "no_tool";
  }
}

export function mapTerminateReasonToTerminal(
  reason: HarnessTerminateReason,
  hasUncertainEffects: boolean = false,
): CyreneRunTerminalResult {
  switch (reason) {
    case "max_rounds":
      return { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true };
    case "timeout":
      return { status: "timeout", reason: "timeout", externalEffectsMayContinue: true };
    case "cancelled":
      return { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true };
    case "error":
      return { status: "runtime_error", reason: "E_HARNESS_FAILURE", externalEffectsMayContinue: true };
    default:
      return { status: "success", externalEffectsMayContinue: hasUncertainEffects };
  }
}
