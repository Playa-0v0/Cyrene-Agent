// 厂商 wire body 推理控制转换 —— 纯函数。
//
// 不持有规则表、不读 cfg（capability 由 adapter 解析后传入）。
// adapter buildRequest 内调用：
//   const cap = resolveReasoningCapability(this.capability.id, cfg.model);
//   const finalBody = applyReasoningPreference(body, cfg.reasoning ?? {mode:"auto"}, cap, ctx);
//
// 决策树见桌面 2026-07-14-reasoning-control-layer-design.md §6.2。
// 关键不变量：
//   - 不修改入参 body，返回新对象
//   - auto 不增加任何字段
//   - 不支持的 effort 已在 resolveEffectiveReasoning 退回 defaultEffort
//     （applyReasoningPreference 信任传入的 preference）
//   - supportsDisable=false 时 off 不发 reasoning_effort:"none"（修订 #1）
//   - fixed-on 走 resolveEffectiveReasoning 后 effective.mode 永远 on，
//     故 applyReasoningPreference 不再判 fixed-on/off → 直接按 on 处理
//   - 互斥字段防御：每个 requestStyle 只用自己专属字段，路径互不交叉
//   - 日志只记 provider / model / requested / effective mode-effort；不记 apiKey / 消息 / reasoning 内容

import { loadModelSettings } from "../..";
import {
  resolveEffectiveReasoning,
  type ReasoningCapability,
  type ReasoningPreference,
} from "../../../shared/reasoning";

export interface ApplyReasoningContext {
  hasTools: boolean;
  providerId: string;
  model: string;
}

export function applyReasoningPreference(
  body: Record<string, unknown>,
  preference: ReasoningPreference,
  capability: ReasoningCapability,
  context: ApplyReasoningContext,
): Record<string, unknown> {
  const effective = resolveEffectiveReasoning(preference, capability, loadModelSettings().thinkingOverride);
  const result: Record<string, unknown> = { ...body };

  // 日志（用户 spec §六 #7）
  const requestedStr = `${preference.mode}/${preference.effort ?? "-"}`;
  const effectiveStr = `${effective.mode}/${effective.effort ?? "-"}`;
  if (requestedStr !== effectiveStr) {
    console.log(
      `[reasoning] provider=${context.providerId} model=${context.model} ` +
      `requested=${requestedStr} effective=${effectiveStr}`,
    );
  }

  // none / dynamic：能力不支持 → 不动 body
  if (capability.control === "none" || capability.control === "dynamic") {
    return result;
  }

  // 1. fixed-on：effective.mode 永远 on；按 requestStyle 注入启用字段
  if (capability.control === "fixed-on") {
    switch (capability.requestStyle) {
      case "thinking-type":
        result.thinking = { type: "enabled" };
        break;
      case "anthropic-adaptive":
        result.thinking = { type: "adaptive" };
        break;
      case "qwen-enable-thinking":
        result.enable_thinking = true;
        break;
      case "openai-effort":
      case "none":
        // 不注入字段（K2.7-Code / K2.7-Code-HighSpeed / M2.x）
        break;
      default: {
        const _exhaustive: never = capability.requestStyle;
        throw new Error(`unsupported requestStyle: ${String(_exhaustive)}`);
      }
    }
    return result;
  }

  // 2. auto：不增加任何字段
  if (effective.mode === "auto") {
    return result;
  }

  // 3. off：按 control + requestStyle 注入关闭字段
  if (effective.mode === "off") {
    switch (capability.control) {
      case "toggle":
        applyToggleOff(result, capability);
        break;
      case "effort":
        // supportsDisable=false → 不发任何字段（用户修订 #1）
        if (capability.supportsDisable) {
          result.reasoning_effort = "none";
        }
        break;
      case "toggle-effort":
        // toggle-effort 中 off 总是发关闭字段（thinking.type = disabled）
        // 若 requestStyle=openai-effort 且 supportsDisable=false，则不发 reasoning_effort
        applyToggleEffortOff(result, capability);
        break;
      default:
        // fixed-on / none / dynamic 已在上方处理
        break;
    }
    return result;
  }

  // 4. on：按 control + requestStyle 注入启用字段
  if (effective.mode === "on") {
    switch (capability.control) {
      case "toggle":
        applyToggleOn(result, capability, context);
        break;
      case "effort": {
        let effort = effective.effort ?? capability.defaultEffort ?? "medium";
        if (effective.effort !== undefined && capability.supportedEfforts && !capability.supportedEfforts.includes(effective.effort)) {
          effort = capability.defaultEffort ?? effort;
        }
        result.reasoning_effort = effort;
        break;
      }
      case "toggle-effort":
        applyToggleEffortOn(result, capability, effective, context);
        break;
      default:
        break;
    }
    return result;
  }

  return result;
}

// ── 辅助函数 ──────────────────────────────────────────────

function applyToggleOff(result: Record<string, unknown>, cap: ReasoningCapability): void {
  switch (cap.requestStyle) {
    case "qwen-enable-thinking":
      result.enable_thinking = false;
      break;
    case "thinking-type":
      result.thinking = { type: "disabled" };
      break;
    case "anthropic-adaptive":
      result.thinking = { type: "disabled" };
      break;
    case "openai-effort":
    case "none":
      // 理论上不存在
      break;
  }
}

function applyToggleOn(
  result: Record<string, unknown>,
  cap: ReasoningCapability,
  context: ApplyReasoningContext,
): void {
  switch (cap.requestStyle) {
    case "qwen-enable-thinking":
      result.enable_thinking = true;
      break;
    case "thinking-type": {
      const keep = cap.keepOnTools === true && context.hasTools;
      result.thinking = keep ? { type: "enabled", keep: "all" } : { type: "enabled" };
      break;
    }
    case "anthropic-adaptive":
      result.thinking = { type: "adaptive" };
      break;
    case "openai-effort":
    case "none":
      // 理论上不存在
      break;
  }
}

function applyToggleEffortOff(result: Record<string, unknown>, cap: ReasoningCapability): void {
  switch (cap.requestStyle) {
    case "openai-effort":
      // supportsDisable=false 时不发（用户修订 #1）
      if (cap.supportsDisable) {
        result.reasoning_effort = "none";
      }
      break;
    case "thinking-type":
      result.thinking = { type: "disabled" };
      break;
    case "anthropic-adaptive":
      result.thinking = { type: "disabled" };
      // 不发 reasoning_effort / output_config.effort
      break;
    case "qwen-enable-thinking":
    case "none":
      // 理论上不存在
      break;
  }
}

function applyToggleEffortOn(
  result: Record<string, unknown>,
  cap: ReasoningCapability,
  effective: ReasoningPreference,
  context: ApplyReasoningContext,
): void {
  let effort = effective.effort ?? cap.defaultEffort ?? "medium";
  // 安全网：effective.effort 不在 supportedEfforts → 退回 defaultEffort
  if (effective.effort !== undefined && cap.supportedEfforts && !cap.supportedEfforts.includes(effective.effort)) {
    effort = cap.defaultEffort ?? effort;
  }
  switch (cap.requestStyle) {
    case "openai-effort":
      result.reasoning_effort = effort;
      break;
    case "thinking-type": {
      const keep = cap.keepOnTools === true && context.hasTools;
      result.thinking = keep ? { type: "enabled", keep: "all" } : { type: "enabled" };
      result.reasoning_effort = effort;
      break;
    }
    case "anthropic-adaptive":
      result.thinking = { type: "adaptive" };
      // 合并已有 output_config，不覆盖
      const existingOutputConfig = (result.output_config ?? {}) as Record<string, unknown>;
      result.output_config = { ...existingOutputConfig, effort };
      break;
    case "qwen-enable-thinking":
    case "none":
      // 理论上不存在
      break;
  }
}