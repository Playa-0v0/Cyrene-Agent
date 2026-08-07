// ToolContext —— 工具執行時調度層注入的上下文。
// 讓工具能拿到"用戶當前問題"與"權限身分 (isOwner)"。

import type { ChatMessage } from "./vendors";

export interface ToolContext {
  /** 用戶當前問題（最後一條 user 消息文本）。最核心字段。 */
  userQuery: string;
  /** 是否為屋主本人（主控用戶）。 */
  isOwner?: boolean;
  /** 未來擴展兜底。 */
  metadata?: Record<string, unknown>;
}

export function extractLastUserQuery(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    const arr = content as unknown;
    if (Array.isArray(arr)) {
      return (arr as Array<{ type?: string; text?: string }>)
        .filter(b => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
        .map(b => b.text as string)
        .join(" ");
    }
    return "";
  }
  return "";
}
