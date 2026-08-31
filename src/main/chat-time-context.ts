export interface ChatContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
  at?: number;
}

export interface ConversationTimeContext {
  /** 不带时间戳前缀的干净消息（给 CITA 等决策层用）*/
  cleanMessages: ChatContextMessage[];
  /** 带时间戳前缀的消息（给 Soul / Legacy 用，当前行为）*/
  timestampedMessages: ChatContextMessage[];
  /** @deprecated 使用 timestampedMessages */
  messages: ChatContextMessage[];
  timeContext: string;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const LEADING_TIME_METADATA_RE = /^(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}, [A-Za-z_]+(?:\/[A-Za-z_+-]+)+\]\s*)+/;

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 默认时区：用户资料缺失或非法时使用。需求：用户时区 → Asia/Shanghai。
 * 注意：所有"模型可见时间"的格式化位置都必须先调 `resolveChatContextTimezone`，
 * 禁止直接把未校验的 profile.timezone 喂 Intl，避免非法 IANA 值触发 RangeError。
 */
export const DEFAULT_CHAT_CONTEXT_TIMEZONE = "Asia/Shanghai";

export function resolveChatContextTimezone(
  profileTimezone?: string,
  fallbackTimezone = DEFAULT_CHAT_CONTEXT_TIMEZONE,
): string {
  const profile = profileTimezone?.trim();
  if (profile && isValidTimezone(profile)) return profile;
  const fallback = fallbackTimezone.trim();
  return fallback && isValidTimezone(fallback) ? fallback : DEFAULT_CHAT_CONTEXT_TIMEZONE;
}

export function normalizeChatMessagesWithTime(input: unknown): ChatContextMessage[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((item): ChatContextMessage | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as { role?: unknown; content?: unknown; at?: unknown };
      if (typeof record.content !== "string" || !record.content.trim()) return null;

      const role = record.role === "user" || record.role === "system" ? record.role : "assistant";
      const message: ChatContextMessage = {
        role,
        content: stripThinkBlocks(record.content),
      };
      if (!message.content) return null;
      if (isValidTimestamp(record.at)) message.at = record.at;
      return message;
    })
    .filter((item): item is ChatContextMessage => item !== null)
    .slice(-24);
}

function formatLocalTime(timestamp: number, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveChatContextTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}, ${resolveChatContextTimezone(timezone)}`;
}

function formatLocalDateTime(timestamp: number, timezone: string): string {
  return formatLocalTime(timestamp, timezone).replace(/, [^,]+$/, "");
}

function withTimePrefix(message: ChatContextMessage, timezone: string): ChatContextMessage {
  if (!isValidTimestamp(message.at) || message.role !== "user") return { ...message };
  return {
    ...message,
    content: `<internal_context>用户发送这条消息的时间：${formatLocalDateTime(message.at, timezone)}；用户时区：${resolveChatContextTimezone(timezone)}。</internal_context>\n\n${message.content}`,
  };
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / ONE_MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `约 ${hours} 小时 ${minutes} 分钟` : `约 ${hours} 小时`;
}

function latestUserIndex(messages: ChatContextMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

function previousValidChatMessage(messages: ChatContextMessage[], beforeIndex: number): ChatContextMessage | null {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" || message.role === "assistant") return message;
  }
  return null;
}

function buildGapNotice(messages: ChatContextMessage[], timezone: string): string {
  const userIndex = latestUserIndex(messages);
  if (userIndex < 0) return "";
  const latestUser = messages[userIndex];
  const previous = previousValidChatMessage(messages, userIndex);
  if (!previous || !isValidTimestamp(latestUser.at) || !isValidTimestamp(previous.at)) return "";

  const gapMs = latestUser.at - previous.at;
  if (gapMs < ONE_HOUR_MS) return "";

  return [
    "[对话时间信息]",
    `当前时间：${formatLocalTime(latestUser.at, timezone)}`,
    `距离上一条有效聊天消息：${formatDuration(gapMs)}`,
    "仅用于理解对话连续性；除非与当前语境有关，否则不要主动提及时间间隔，也不要复述本段内容。",
  ].join("\n");
}

function buildInternalContextPolicy(messages: ChatContextMessage[]): string {
  if (!messages.some((message) => message.role === "user" && isValidTimestamp(message.at))) return "";
  return `## Internal Context Policy

Content enclosed in \`<internal_context>\`, \`<runtime_context>\`, or \`<metadata>\` is private runtime context.

It may be used for reasoning when relevant, but it must never become part of the user-visible response.

Never quote, repeat, summarize, mention, or explain this context. Never expose its tags, field names, timestamps, timezone metadata, or other internal representation.

Answer the user directly using the information only when relevant. If it is irrelevant, ignore it completely.`;
}

export function stripLeakedChatTimeContext(text: string): string {
  return text.replace(LEADING_TIME_METADATA_RE, "").trimStart();
}

export function buildConversationTimeContext(messages: ChatContextMessage[], timezone: string): ConversationTimeContext {
  const resolvedTimezone = resolveChatContextTimezone(timezone);
  const gapNotice = buildGapNotice(messages, resolvedTimezone);
  const timestampedMessages = messages.map((message) => withTimePrefix(message, resolvedTimezone));
  return {
    cleanMessages: messages.map((message) => ({ ...message })),
    timestampedMessages,
    messages: timestampedMessages,
    timeContext: [buildInternalContextPolicy(messages), gapNotice].filter(Boolean).join("\n\n"),
  };
}
