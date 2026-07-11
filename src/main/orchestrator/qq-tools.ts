import { channelManager } from "../channels/manager";
import { appendLog, getRecentLog } from "../channels/message-log";
import { loadChannelsSettings } from "../channels/settings-store";
import type { OutgoingMessage } from "../channels/types";
import { toolRegistry } from "./tool-registry";

type QqTargetType = "private" | "group";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseTargetType(value: unknown): QqTargetType | "auto" {
  return value === "private" || value === "group" ? value : "auto";
}

function resolveRecentTarget(preferred: QqTargetType | "auto"): { targetId: string; targetType: QqTargetType; label: string } | null {
  const recent = getRecentLog(50)
    .filter((entry) => entry.channel === "qq")
    .reverse()
    .find((entry) => {
      const isGroup = entry.senderId.startsWith("group:");
      if (preferred === "private") return !isGroup;
      if (preferred === "group") return isGroup;
      return true;
    });
  if (!recent) return null;

  const isGroup = recent.senderId.startsWith("group:");
  return {
    targetId: isGroup ? recent.chatId : recent.senderId,
    targetType: isGroup ? "group" : "private",
    label: recent.senderName || recent.senderId || recent.chatId,
  };
}

async function executeSendQqMessage(args: Record<string, unknown>): Promise<string> {
  const text = str(args.text);
  if (!text) return "[error] text is required.";

  const preferredType = parseTargetType(args.targetType);
  let targetId = str(args.targetId);
  let targetType: QqTargetType = preferredType === "auto" ? "private" : preferredType;
  let targetLabel = str(args.targetName) || targetId;

  if (targetId === "me" || targetId === "owner") {
    const ownerQq = loadChannelsSettings().qq.ownerQq?.trim();
    if (!ownerQq) return "[error] Owner QQ is not configured in settings.";
    targetId = ownerQq;
    targetType = "private";
    targetLabel = "主人";
  } else if (!targetId || targetId === "recent" || targetId === "latest") {
    const recent = resolveRecentTarget(preferredType);
    if (!recent) {
      return "[error] No recent QQ contact found. Ask the user for targetId, or receive a QQ message first.";
    }
    targetId = recent.targetId;
    targetType = recent.targetType;
    targetLabel = recent.label;
  }

  const adapter = channelManager.getAdapter("qq");
  if (!adapter) return "[error] QQ adapter is not registered.";

  const status = adapter.getStatus();
  if (!status.enabled) return "[error] QQ/NapCat channel is disabled in settings.";
  if (status.phase !== "running") {
    return `[error] QQ/NapCat is not connected. Current status: ${status.phase}${status.message ? ` (${status.message})` : ""}`;
  }

  const outgoing: OutgoingMessage = {
    channel: "qq",
    targetId,
    threadId: targetType === "group" ? targetId : undefined,
    parts: [{ kind: "text", text }],
  };
  const result = await adapter.send(outgoing);
  if (!result.ok) return `[error] Failed to send QQ message: ${result.error || "unknown error"}`;

  appendLog({
    dir: "outgoing",
    channel: "qq",
    senderId: targetId,
    senderName: targetLabel || undefined,
    chatId: targetId,
    text,
    hasAttachments: false,
  });

  return `[ok] Sent QQ ${targetType} message to ${targetLabel || targetId}: ${text}`;
}

toolRegistry.register({
  id: "send_qq_message",
  name: "Send QQ message",
  description:
    "Send a real QQ message through the connected NapCat / OneBot WebSocket channel. " +
    "Use this when the user asks you to send, notify, or proactively message someone on QQ. " +
    "If the user says 'send me a QQ message' or the target is the latest QQ contact, set targetId to 'recent'. " +
    "For group chats set targetType to 'group'; for private chats set targetType to 'private'.",
  enabled: true,
  risk: "network",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Message text to send." },
      targetId: {
        type: "string",
        description: "QQ user id or group id. Use 'recent' to send to the latest QQ contact.",
      },
      targetType: {
        type: "string",
        enum: ["private", "group", "auto"],
        description: "private, group, or auto. Defaults to auto/private when targetId is explicit.",
      },
      targetName: {
        type: "string",
        description: "Optional human-readable contact name for logs only.",
      },
    },
    required: ["text"],
  },
  execute: executeSendQqMessage,
});
