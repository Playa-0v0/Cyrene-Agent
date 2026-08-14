// Discord 頻道 ↔ 桌面端聊天對話 的橋接。
//
// /startagent 綁定頻道後，建立一個 stable purpose 為 "discord-channel" 的桌面端
// 對話（chat 模式）。之後該 DC 頻道「給 agent 處理的那則用戶訊息 + Bot 回覆」
// 都會鏡像寫進這個對話，並透過 broadcastChanged 讓桌面端聊天窗即時更新，方便
// 使用者確認完整對話內容。
import { randomUUID } from "crypto";
import * as chatsStore from "../../../chats/chats-store";
import { broadcastChatsChanged } from "../../../chats/chats-ipc";
import type { ChatMessage } from "../../../../shared/chat-types";

const PURPOSES = "discord-channel" as const;

/** /startagent 成功後，由 bootstrap 注入「開啟桌面端聊天窗並切到指定 session」的回調。 */
let openSessionHandler: ((sessionId: string) => void) | null = null;

export function setDiscordSessionOpenHandler(fn: ((sessionId: string) => void) | null): void {
  openSessionHandler = fn;
}

/** 取得（或建立）Discord 對話。title 只用於首次建立；後續沿用。 */
export function getOrCreateDiscordSession(title: string): { id: string } | null {
  try {
    chatsStore.initialize();
    const session = chatsStore.getOrCreateSessionByPurpose(PURPOSES, { title });
    return session ? { id: session.id } : null;
  } catch (err) {
    console.warn("[DiscordSession] 建立 Discord 對話失敗:", err instanceof Error ? err.message : err);
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
