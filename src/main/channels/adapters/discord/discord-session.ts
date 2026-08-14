// Discord 頻道 ↔ 桌面端聊天對話 的橋接。
//
// /startagent 綁定頻道後，建立一個 stable purpose 為 "discord-channel" 的桌面端
// 對話（chat 模式）。之後該 DC 頻道「給 agent 處理的那則用戶訊息 + Bot 回覆」
// 都會鏡像寫進這個對話，並透過 broadcastChanged 讓桌面端聊天窗即時更新，方便
// 使用者確認完整對話內容。
import { randomUUID } from "crypto";
import * as chatsStore from "../../../chats/chats-store";
import { broadcastChatsChanged } from "../../../chats/chats-ipc";
import { loadChannelsSettings } from "../../settings-store";
import type { ChatMessage, ConversationMode } from "../../../../shared/chat-types";

const PURPOSES = "discord-channel" as const;

/** 依目前「工具权限(toolSandbox)」決定 Discord 桌面端對話的模式：all→work，off→chat。 */
function discordSessionMode(): ConversationMode {
  return loadChannelsSettings().toolSandbox === "all" ? "work" : "chat";
}

/** /startagent 成功後，由 bootstrap 注入「開啟桌面端聊天窗並切到指定 session」的回調。 */
let openSessionHandler: ((sessionId: string) => void) | null = null;

export function setDiscordSessionOpenHandler(fn: ((sessionId: string) => void) | null): void {
  openSessionHandler = fn;
}

/** 取得（或建立）Discord 對話。title 只用於首次建立；後續沿用。
 *  mode 依目前 toolSandbox：all→work / off→chat；既有對話若 mode 不符會同步更新。 */
export function getOrCreateDiscordSession(title: string): { id: string } | null {
  try {
    chatsStore.initialize();
    const session = chatsStore.getOrCreateSessionByPurpose(PURPOSES, { title }, discordSessionMode());
    return session ? { id: session.id } : null;
  } catch (err) {
    console.warn("[DiscordSession] 建立 Discord 對話失敗:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** 立即把桌面端 Discord 對話的 mode 對齊目前 toolSandbox（/mode 切換後呼叫），並廣播刷新。 */
export function syncDiscordSessionMode(): void {
  try {
    const sessionId = getDiscordSessionId();
    if (!sessionId) return;
    const target = discordSessionMode();
    const updated = chatsStore.setSessionMode(sessionId, target);
    if (updated) {
      broadcastChatsChanged();
      console.log("[DiscordSession] 對話模式已同步為", target);
    }
  } catch (err) {
    console.warn("[DiscordSession] 同步模式失敗:", err instanceof Error ? err.message : err);
  }
}

/** 取得桌面端 Discord 對話的 id（存在才回，不存在 null）。 */
export function getDiscordSessionId(): string | null {
  try {
    chatsStore.initialize();
    return chatsStore.getSessionByPurpose(PURPOSES)?.id ?? null;
  } catch {
    return null;
  }
}

/** 取得桌面端 Discord 對話綁定的工作目錄（「指定資料夾」）。未綁定回 null。 */
export function getDiscordSessionWorkspace(): { workspaceRoot: string; displayName?: string } | null {
  try {
    const session = chatsStore.getSession(getDiscordSessionId() ?? "");
    if (!session?.workspaceBinding?.workspaceRoot) return null;
    return {
      workspaceRoot: session.workspaceBinding.workspaceRoot,
      displayName: session.workspaceBinding.displayName,
    };
  } catch {
    return null;
  }
}

/** 建立/確保 Discord 對話存在，並要求開啟桌面端聊天窗（若尚未開啟）。返回 sessionId。 */
export function ensureDiscordSessionAndOpen(title: string): string | null {
  const info = getOrCreateDiscordSession(title);
  if (info) {
    try {
      broadcastChatsChanged();
      openSessionHandler?.(info.id);
    } catch (err) {
      console.warn("[DiscordSession] 開啟桌面端聊天窗失敗:", err instanceof Error ? err.message : err);
    }
  }
  return info?.id ?? null;
}

/** 把「給 agent 處理的那則用戶訊息」寫進 Discord 對話。 */
export function appendDiscordUserMessage(title: string, text: string, at = Date.now()): void {
  const info = getOrCreateDiscordSession(title);
  if (!info || !text.trim()) return;
  const msg: ChatMessage = { id: randomUUID(), role: "user", content: text.trim(), at };
  try {
    chatsStore.appendMessage(info.id, msg);
    broadcastChatsChanged();
  } catch (err) {
    console.warn("[DiscordSession] 寫入 Discord 用戶訊息失敗:", err instanceof Error ? err.message : err);
  }
}

/** 把「Bot 對該頻道訊息的回覆」寫進 Discord 對話。 */
export function appendDiscordReply(title: string, text: string, at = Date.now()): void {
  const info = getOrCreateDiscordSession(title);
  if (!info || !text.trim()) return;
  const msg: ChatMessage = { id: randomUUID(), role: "model", content: text.trim(), at };
  try {
    chatsStore.appendMessage(info.id, msg);
    broadcastChatsChanged();
  } catch (err) {
    console.warn("[DiscordSession] 寫入 Discord 回覆失敗:", err instanceof Error ? err.message : err);
  }
}

// ── 最近一次渠道錯誤（供 /status 除錯） ─────────────────────────────

export interface LastChannelError {
  at: number;
  channel: string;
  errorName?: string;
  errorCode?: string;
  errorMessage: string;
}

let lastChannelError: LastChannelError | null = null;

/** bootstrap 在 agent 調用失敗時記錄（不限 Discord，非 Discord 也會被記但僅用於 /status 展示）。 */
export function recordChannelError(err: unknown, channelHex?: string): void {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
  lastChannelError = {
    at: Date.now(),
    channel: channelHex ?? "",
    errorName: typeof e?.name === "string" ? e.name : undefined,
    errorCode: typeof e?.code === "string" ? e.code : undefined,
    errorMessage:
      typeof e?.message === "string" && e.message.trim()
        ? e.message
        : err instanceof Error
          ? err.message
          : String(err),
  };
}

export function getLastChannelError(): LastChannelError | null {
  return lastChannelError;
}
