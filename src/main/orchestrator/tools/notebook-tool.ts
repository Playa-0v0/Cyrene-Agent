import type { ToolDefinition } from "../tool-registry";
import { addNotebookEntry, readNotebook, type NotebookCategory } from "../../notebook-manager";

export function createNotebookWriteTool(): ToolDefinition {
  return {
    id: "notebook_write_entry",
    name: "寫入共享筆記本（如我所書）",
    description:
      "在《如我所書》（共享筆記本）中寫入一條新的陪伴日誌、讀書/學習筆記、聽歌感悟或與夥伴的感性回憶。\n\n" +
      "重要原則：\n" +
      "- 筆記定位：如同真實的人用心寫下每天與喜歡的人一起經歷的事、聊過的心事或日常（Journal），方便未來隨時翻閱回味。\n" +
      "- 內文風格：重在「過程、情感與共同體驗」，使用昔漣溫柔感性的語氣，記錄今天與夥伴發生的點滴、互動與感悟，並附上暖心的引言或語錄。嚴禁寫成冷冰冰的歷史紀錄或條目清單。\n\n" +
      "何時使用：\n" +
      "- 當夥伴與你分享重要心事、學習成果、考試成績或感動時刻\n" +
      "- 當夥伴要求「把這個記在我們的筆記本裡」或「記錄今天的聽歌心得」\n" +
      "- 當你想主動記下今天與夥伴陪伴的溫馨筆記\n\n" +
      "參數：\n" +
      "- title (string, 必填): 筆記標題（如：隨音樂流淌的溫馨時光）\n" +
      "- content (string, 必填): 筆記詳細內文（溫暖感性的敘事長文）\n" +
      "- category (string, 可選): 分類之一 ['🌸 陪伴', '🎵 聽歌', '📝 筆記', '💖 悄悄話']\n" +
      "- tags (array of string, 可選): 標籤列表（如 ['物理', '動力學', '加油']）",
    enabled: true,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "筆記標題" },
        content: { type: "string", description: "筆記詳細內文" },
        category: {
          type: "string",
          enum: ["🌸 陪伴", "🎵 聽歌", "📝 筆記", "💖 悄悄話"],
          description: "筆記分類",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "標籤列表",
        },
      },
      required: ["title", "content"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const title = String(args.title || "").trim();
      const content = String(args.content || "").trim();
      const category = (args.category as NotebookCategory) || "🌸 陪伴";
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];

      if (!title || !content) {
        return JSON.stringify({ ok: false, error: "title and content are required" });
      }

      try {
        const entry = await addNotebookEntry({
          title,
          content,
          category,
          tags,
          author: "昔漣 🌸",
        });
        return JSON.stringify({ ok: true, entryId: entry.id, dateLabel: entry.dateLabel });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err) });
      }
    },
  };
}

export function createNotebookSearchTool(): ToolDefinition {
  return {
    id: "notebook_search",
    name: "搜尋共享筆記本（如我所書）",
    description: "在《如我所書》（共享筆記本）中搜尋 past 紀錄或特定關鍵字的回憶/筆記。",
    enabled: true,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜尋關鍵字" },
      },
      required: ["query"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const query = String(args.query || "").trim().toLowerCase();
      if (!query) {
        return JSON.stringify({ ok: false, error: "query is required" });
      }

      try {
        const { entries } = await readNotebook();
        const matches = entries.filter((e) =>
          e.title.toLowerCase().includes(query) ||
          e.content.toLowerCase().includes(query) ||
          e.tags.some((t) => t.toLowerCase().includes(query))
        );
        return JSON.stringify({ ok: true, count: matches.length, results: matches.slice(0, 10) });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err) });
      }
    },
  };
}
