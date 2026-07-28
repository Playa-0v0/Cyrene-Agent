export type NormalizedFinishReason =
  | "complete"
  | "truncated"
  | "tool_call"
  | "content_filtered"
  | "refused"
  | "unknown";

export function normalizeFinishReason(reason: string | undefined): NormalizedFinishReason {
  switch (reason) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
      return "complete";
    case "length":
    case "max_tokens":
      return "truncated";
    case "tool_calls":
    case "tool_use":
      return "tool_call";
    case "content_filter":
      return "content_filtered";
    case "refusal":
      return "refused";
    default:
      return "unknown";
  }
}

