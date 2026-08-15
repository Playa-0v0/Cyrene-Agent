// Discord 頻道 ↔ 桌面端聊天對話 的橋接。
//
// /startagent 綁定頻道後，依目前的執行模式(toolSandbox)把訊息寫進對應的桌面對話：
//   - toolSandbox=off（Chat） → `discord-chat` 對話（chat 模式）
//   - toolSandbox=all（Work） → `discord-work` 對話（work 模式）
// work 與 chat 是**兩個獨立對話**；/mode 切換 toolSandbox 時，之後的頻道訊息自動進到
// 對應的對話，不會去翻動同一個對話的 mode。
import { randomUUID } from "crypto";
import * as chatsStore from "../../../chats/chats-store";
import { broadcastChatsChanged } from "../../../chats/chats-ipc";
import { loadChannelsSettings, saveChannelsSettings } from "../../settings-store";
import type { ChatMessage, ChatSessionPurpose, ConversationMode } from "../../../../shared/chat-types";

/** 依目前 toolSandbox 選對話 purpose：all→discord-work、off→discord-chat。 */
function currentDiscordPurpose(): ChatSessionPurpose {
  return loadChannelsSettings().toolSandbox === "all" ? "discord-work" : "discord-chat";
}

/** 依 purpose 回傳對應的對話標題（首次建立用）。 */
function titleForPurpose(purpose: ChatSessionPurpose): string {
  return purpose === "discord-work" ? "Discord 對話 (Work)" : "Discord 對話 (Chat)";
}

/** /startagent 成功後，由 bootstrap 注入「開啟桌面端聊天窗並切到指定 session」的回調。 */
let openSessionHandler: ((sessionId: string) => void) | null = null;

export function setDiscordSessionOpenHandler(fn: ((sessionId: string) => void) | null): void {
  openSessionHandler = fn;
}

/** 取得（或建立）目前 mode 對應的 Discord 對話（work/chat 各自獨立）。 */
export function getCurrentDiscordSession(): { id: string; purpose: ChatSessionPurpose } | null {
  try {
    chatsStore.initialize();
    const purpose = currentDiscordPurpose();
    const mode: ConversationMode = purpose === "discord-work" ? "work" : "chat";
    const session = chatsStore.getOrCreateSessionByPurpose(purpose, { title: titleForPurpose(purpose) }, mode);
    return session ? { id: session.id, purpose } : null;
  } catch (err) {
    console.warn("[DiscordSession] 建立 Discord 對話失敗:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** 把目前 mode 的桌面對話 session id 記到 Discord 設定（workSessionId/chatSessionId），純供對應定位。 */
export function recordCurrentDiscordSessionId(): void {
  try {
    const info = getCurrentDiscordSession();
    const mode = currentDiscordMode();
    if (!info) return;
    const cfg = loadChannelsSettings().discord;
    const patch: { workSessionId?: string; chatSessionId?: string } =
      mode === "work"
        ? { workSessionId: info.id }
        : { chatSessionId: info.id };
    saveChannelsSettings({ discord: { ...cfg, ...patch } });
  } catch (err) {
    console.warn("[DiscordSession] 記錄 session id 失敗:", err instanceof Error ? err.message : err);
  }
}

/** 目前 mode 的對話 purpose（work/chat 判斷，供 /status）。 */
export function currentDiscordMode(): "work" | "chat" {
  return loadChannelsSettings().toolSandbox === "all" ? "work" : "chat";
}

/** 建立/確保目前 mode 對話存在，並要求開啟桌面端聊天窗。返回 sessionId。 */
export function ensureDiscordSessionAndOpen(): string | null {
  const info = getCurrentDiscordSession();
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

/** 把「給 agent 處理的那則用戶訊息」寫進目前 mode 的 Discord 對話。 */
export function appendDiscordUserMessage(text: string, at = Date.now()): void {
  const info = getCurrentDiscordSession();
  if (!info || !text.trim()) return;
  const msg: ChatMessage = { id: randomUUID(), role: "user", content: text.trim(), at };
  try {
    chatsStore.appendMessage(info.id, msg);
    broadcastChatsChanged();
  } catch (err) {
    console.warn("[DiscordSession] 寫入 Discord 用戶訊息失敗:", err instanceof Error ? err.message : err);
  }
}

/** 把「Bot 對該頻道訊息的回覆」寫進目前 mode 的 Discord 對話。 */
export function appendDiscordReply(text: string, at = Date.now()): void {
  const info = getCurrentDiscordSession();
  if (!info || !text.trim()) return;
  const msg: ChatMessage = { id: randomUUID(), role: "model", content: text.trim(), at };
  try {
    chatsStore.appendMessage(info.id, msg);
    broadcastChatsChanged();
  } catch (err) {
    console.warn("[DiscordSession] 寫入 Discord 回覆失敗:", err instanceof Error ? err.message : err);
  }
}

/** 取得目前 mode 的 Discord 對話綁定之工作目錄（「指定資料夾」）。未綁定回 null。 */
export function getDiscordSessionWorkspace(): { workspaceRoot: string; displayName?: string } | null {
  try {
    const info = getCurrentDiscordSession();
    if (!info) return null;
    const session = chatsStore.getSession(info.id);
    if (!session?.workspaceBinding?.workspaceRoot) return null;
    return {
      workspaceRoot: session.workspaceBinding.workspaceRoot,
      displayName: session.workspaceBinding.displayName,
    };
  } catch {
    return null;
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
