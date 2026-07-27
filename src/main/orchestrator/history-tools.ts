// 歷史對話召回工具 —— 讓昔漣能"回憶"滾出上下文窗口的對話。
//
// 設計（見 docs/history-and-skill-architecture.md）：
// - 不切分、不壓縮、不啟發式。全部歷史無損存入向量庫，模型主動召回。
// - 存：每輪 user + assistant 消息用 addMemory 存入 source="chat_history"
// - 取：recall_history 工具語義檢索，按時間排序返回
//
// 複用現有 RAG 引擎（addMemory / searchHistoryEntries），不另建存儲層。

import { addMemory, searchHistoryEntries } from "../rag";
import { toolRegistry } from "./tool-registry";

const LOG_PREFIX = "[History]";

/**
 * 把一輪對話存入向量庫。在 agui-bridge 的 complete 回調裡調用。
 * user 和 assistant 各存一條，方便按角色召回。
 * 失敗不拋錯（歷史存儲是副作用，不能影響主流程）。
 */
export async function indexConversationTurn(
  sessionId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const ts = Date.now();
  try {
    if (userText) {
      await addMemory(userText, "chat_history", { sessionId, role: "user", ts });
    }
    if (assistantText) {
      await addMemory(assistantText, "chat_history", { sessionId, role: "assistant", ts });
    }
  } catch (e) {
    console.warn(LOG_PREFIX, "索引對話失敗:", e);
  }
}

/** 註冊 recall_history 工具。在 startup 調一次。 */
export function registerRecallHistoryTool(): void {
  toolRegistry.register({
    id: "recall_history",
    name: "回憶歷史",
    description:
      "從所有歷史對話中語義檢索相關內容。返回按時間排序的相關片段（最多 5 條），每條帶角色和時間戳。\n\n" +
      "何時用：\n" +
      "- 用戶說「還記得」「上次」「之前」「那個」「前幾天」等指代詞\n" +
      "- 用戶問的事在最近幾輪對話裡找不到答案\n" +
      "- 用戶接續之前的話題但當前上下文沒有細節\n\n" +
      "不要用於：\n" +
      "- 當前對話最近幾輪裡能直接看到的信息\n" +
      "- 完全無關的閒聊\n" +
      "- 用戶從沒提過的事（查不到就老實說不知道）\n\n" +
      "參數：query（必填，檢索關鍵詞或自然語言問題），days（可選，限制最近 N 天，默認 30）。",
    enabled: true,
    risk: "safe",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "檢索關鍵詞或自然語言問題" },
        days: { type: "number", description: "可選，限制最近 N 天，默認 30" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const query = String(args.query || "").trim();
      if (!query) return "[錯誤] query 不能為空";

      const days = Number(args.days) || 30;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

      let hits;
      try {
        hits = await searchHistoryEntries(query, 5);
      } catch (e) {
        return "[recall_history] 檢索失敗：" + (e instanceof Error ? e.message : String(e));
      }

      const filtered = hits.filter(h => h.createdAt >= cutoff);

      if (filtered.length === 0) {
        return `[recall_history] 沒有找到關於 "${query}" 的歷史記錄`;
      }

      // 按時間正序（最早的在前），讓對話脈絡自然
      const sorted = [...filtered].sort((a, b) => a.createdAt - b.createdAt);

      const lines = sorted.map(h => {
        const date = new Date(h.createdAt).toLocaleString("zh-CN");
        const role = h.metadata?.role === "user" ? "用戶" : "昔漣";
        // 截斷過長內容，避免吃太多 token
        const text = h.text.length > 300 ? h.text.slice(0, 300) + "..." : h.text;
        return `[${date}] ${role}：${text}`;
      });

      return `[recall_history] 找到 ${sorted.length} 條相關歷史：\n\n${lines.join("\n\n")}`;
    },
  });
}
