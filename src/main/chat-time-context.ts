export interface ChatContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
  at?: number;
}

export interface ConversationTimeContext {
  messages: ChatContextMessage[];
  timeContext: string;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

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

function systemTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone && isValidTimezone(timezone) ? timezone : "UTC";
}

export function resolveChatContextTimezone(profileTimezone?: string, fallbackTimezone = systemTimezone()): string {
  const profile = profileTimezone?.trim();
  if (profile && isValidTimezone(profile)) return profile;
  const fallback = fallbackTimezone.trim();
  return fallback && isValidTimezone(fallback) ? fallback : "UTC";
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

function withTimePrefix(message: ChatContextMessage, timezone: string): ChatContextMessage {
  if (!isValidTimestamp(message.at)) return { ...message };
  return {
    ...message,
    content: `[${formatLocalTime(message.at, timezone)}]\n${message.content}`,
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
    "仅用于理解对话连续性；除非与当前语境有关，否则不要主动提及时间间隔。",
  ].join("\n");
}

export function buildConversationTimeContext(messages: ChatContextMessage[], timezone: string): ConversationTimeContext {
  const resolvedTimezone = resolveChatContextTimezone(timezone);
  return {
    messages: messages.map((message) => withTimePrefix(message, resolvedTimezone)),
    timeContext: buildGapNotice(messages, resolvedTimezone),
  };
}
