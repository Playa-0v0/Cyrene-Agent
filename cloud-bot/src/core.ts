import { createHash } from "node:crypto";
import type { CloudBotConfig } from "./config.js";

export type ChatRole = "user" | "assistant";
export type ChatEntry = { sessionId: string; role: ChatRole; content: string; at: number };

function allowed(allowlist: Set<string>, id: string | null | undefined): boolean {
  return allowlist.size === 0 || (!!id && allowlist.has(id));
}

export function shouldHandleMessage(
  input: { userId: string; guildId?: string | null; channelId: string; isDm: boolean; mentioned: boolean },
  config: Pick<CloudBotConfig, "allowedUserIds" | "allowedGuildIds" | "allowedChannelIds" | "requireMention">,
): boolean {
  if (!allowed(config.allowedUserIds, input.userId)) return false;
  if (!allowed(config.allowedChannelIds, input.channelId)) return false;
  if (input.guildId && !allowed(config.allowedGuildIds, input.guildId)) return false;
  return input.isDm || !config.requireMention || input.mentioned;
}

export function normalizeInvocation(content: string, botUserId: string): string {
  const escapedId = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = content.replace(new RegExp(`<@!?${escapedId}>`, "g"), "").trim();
  return text || "嗨";
}

export function mentionsBot(content: string, botUserId: string): boolean {
  return content.includes(`<@${botUserId}>`) || content.includes(`<@!${botUserId}>`);
}

export function sessionIdFor(userId: string, channelId: string): string {
  return createHash("sha256").update(`${userId}:${channelId}`).digest("hex").slice(0, 24);
}

export function splitDiscordText(text: string, limit = 1_900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}
