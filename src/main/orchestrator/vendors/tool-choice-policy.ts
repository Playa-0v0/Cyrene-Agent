import { resolveEffectiveReasoning, resolveReasoningCapability, type ReasoningPreference } from "../../../shared/reasoning";
import type { Transport } from "./types";

export type ToolChoicePolicy =
  | { kind: "named"; name: string }
  | { kind: "required" }
  | { kind: "auto" }
  | { kind: "omit" };

export interface ToolChoicePolicyInput {
  providerId: string;
  model: string;
  transport: Transport;
  reasoning: ReasoningPreference;
  requestedToolName: string;
  supportedModes?: ReadonlyArray<ToolChoicePolicy["kind"]>;
}

export type AutomaticToolChoicePolicyInput = Omit<ToolChoicePolicyInput, "requestedToolName">;

function isThinkingEnabled(input: AutomaticToolChoicePolicyInput): boolean {
  return resolveEffectiveReasoning(
    input.reasoning,
    resolveReasoningCapability(input.providerId, input.model),
  ).mode === "on";
}

/** Map an ordinary optional Function Calling turn to auto, unless the active mode rejects tool_choice. */
export function resolveAutomaticToolChoicePolicy(input: AutomaticToolChoicePolicyInput): "auto" | "omit" {
  if (input.providerId === "deepseek" && isThinkingEnabled(input)) return "omit";
  if (input.supportedModes && !input.supportedModes.includes("auto")) return "omit";
  return "auto";
}

/** Resolve a must-call intent into the strongest wire policy supported by the active model mode. */
export function resolveToolChoicePolicy(input: ToolChoicePolicyInput): ToolChoicePolicy {
  const thinkingEnabled = isThinkingEnabled(input);
  const supported = input.supportedModes;
  const result = (kind: ToolChoicePolicy["kind"]): ToolChoicePolicy => (
    kind === "named" ? { kind, name: input.requestedToolName } : { kind }
  );
  const choose = (preferred: ToolChoicePolicy["kind"]): ToolChoicePolicy => {
    if (!supported?.length || supported.includes(preferred)) return result(preferred);
    for (const fallback of ["named", "required", "auto", "omit"] as const) {
      if (supported.includes(fallback)) return result(fallback);
    }
    return { kind: "omit" };
  };

  // MiniMax OpenAI-compatible text API documents auto/none only.
  if (input.providerId === "minimax") return choose("auto");
  if (input.providerId === "anySearch") return choose("auto");
  // DeepSeek thinking rejects tool_choice entirely, while non-thinking accepts named selection.
  if (input.providerId === "deepseek" && thinkingEnabled) return choose("omit");
  // Kimi fixed/thinking models reject specified selection; auto keeps native Function Calling enabled.
  if (input.providerId === "kimi" && thinkingEnabled) return choose("auto");
  // Anthropic extended thinking supports auto/none, not any/tool.
  if (input.transport === "anthropic" && thinkingEnabled) return choose("auto");
  return choose("named");
}
