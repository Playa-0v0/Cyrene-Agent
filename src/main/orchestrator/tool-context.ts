// ToolContext —— 工具執行時調度層注入的上下文。
// 讓工具能拿到"用戶當前問題"，而不是自己去翻消息歷史。
// 地基通用：當前只服務於 read_image（視覺），未來其他工具按需聲明 needsContext 接入。

import type { ChatMessage } from "./vendors";

/** 工具上下文。userQuery 是當前唯一穩定字段；metadata 留未來擴展（PDF/音頻等），現在不填。 */
export interface ToolContext {
  /** 用戶當前問題（最後一條 user 消息文本）。最核心字段。 */
  userQuery: string;
  /** 未來擴展兜底；當前為空對象，不預設字段。遵循"地基通用，上層剋制"。 */
  metadata?: Record<string, unknown>;
}

/**
 * 從對話歷史取最後一條 role:"user" 消息的文本，作為工具的用戶問題上下文。
 *
 * 邊界規則：
 * - content 是字符串 → 直接用
 * - content 是數組（未來上傳圖片後的多模態消息）→ 拼接所有 type:"text" 塊的文本
 * - 都不是或無 user 消息 → 返回空串
 *
 * 已知邊界（不解決）：多輪 function-calling 後用戶追問（如"那第二張呢？"），
 * 取到的是追問片段而非原始意圖。視覺模型通常仍能結合圖片+片段理解，所以不處理。
 */
export function extractLastUserQuery(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    // 多模態數組：拼 text 塊（未來用，當前 content 永遠是 string）。
    // ChatMessage.content 當前類型只有 string，這裡用 unknown 中轉避免 TS 收窄成 never；
    // 未來 content 改成 string | ContentBlock[] 後可去掉斷言。
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
