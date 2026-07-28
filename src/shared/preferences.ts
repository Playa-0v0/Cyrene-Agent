export type DefaultChatMode = "work" | "chat";
export type SegmentedOutputMode = "all" | "chat" | "off";
export type MobileMessageSegmentationMode = "on" | "off";
export type ProactiveChatMode = "on" | "off";
export type ProactiveDeliveryTarget = "local" | "wechat" | "feishu";

export type { CustomStyleConfig, StyleId } from "./style-sampling";

export function normalizeChatSocialContextEnabled(value: unknown): boolean {
  return value === true;
}

export function normalizeDefaultChatMode(value: unknown): DefaultChatMode {
  // 兼容旧版磁盘值：talk -> chat，collab -> work。
  return value === "chat" || value === "talk" ? "chat" : "work";
}

export function normalizeSegmentedOutputMode(value: unknown): SegmentedOutputMode {
  return value === "all" || value === "chat" ? value : "off";
}

export function normalizeMobileMessageSegmentationMode(value: unknown): MobileMessageSegmentationMode {
  return value === "on" ? "on" : "off";
}

export function normalizeProactiveChatMode(value: unknown): ProactiveChatMode {
  return value === "on" ? "on" : "off";
}

export function normalizeProactiveDeliveryTarget(value: unknown): ProactiveDeliveryTarget {
  return value === "wechat" || value === "feishu" ? value : "local";
}
