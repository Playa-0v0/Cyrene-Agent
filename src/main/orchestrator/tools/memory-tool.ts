import type { ToolDefinition } from "../tool-registry";
import { memoryStore } from "../../memory/memory-store";
import { addMemory } from "../../rag";

export function createMemorySaveUserFactTool(): ToolDefinition {
  return {
    id: "memory_save_user_fact",
    name: "儲存使用者偏好/記憶",
    description:
      "當使用者提及個人明確喜好、習慣、重要背景或要求「記住這個...」時，主動將其存入昔漣的記憶庫。\n\n" +
      "參數：\n" +
      "- fact (string, 必填): 記憶內文（如：夥伴喜歡半糖去冰黑糖珍珠鮮奶）\n" +
      "- type (string, 可選): ['l0_preference', 'l1_recent_project', 'l2_event'] 預設為 'l2_event'\n" +
      "- keywords (array of string, 可選): 關鍵字（如 ['飲料', '珍珠鮮奶']）",
    enabled: true,
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "記憶內容" },
        type: {
          type: "string",
          enum: ["l0_preference", "l1_recent_project", "l2_event"],
          description: "記憶層級類型",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "關鍵字列表",
        },
      },
      required: ["fact"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const fact = String(args.fact || "").trim();
      const type = (args.type as string) || "l2_event";
      const keywords = Array.isArray(args.keywords) ? args.keywords.map(String) : [];

      if (!fact) {
        return JSON.stringify({ ok: false, error: "fact is required" });
      }

      try {
        if (type === "l0_preference") {
          const currentL0 = await memoryStore.getL0();
          const newNotes = currentL0.permanentNote ? `${currentL0.permanentNote}；${fact}` : fact;
          await memoryStore.upsertL0Field("permanentNote", newNotes);
        } else if (type === "l1_recent_project") {
          await memoryStore.updateL1({ currentProject: fact });
        } else {
          const memory = await memoryStore.addL2Memory({
            content: fact,
            triggerText: fact,
            sourceConversationId: "chat",
            isPinned: false,
          });
          try {
            const ragId = await addMemory(fact, "user_memory", {
              l2Id: memory.id,
              triggerText: fact,
              sourceConversationId: "chat",
            });
            await memoryStore.markL2SyncStatus(memory.id, "synced", ragId);
          } catch (error) {
            await memoryStore.markL2SyncStatus(memory.id, "sync_failed", undefined, error);
            throw error;
          }
        }
        return JSON.stringify({ ok: true, savedFact: fact });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err) });
      }
    },
  };
}
