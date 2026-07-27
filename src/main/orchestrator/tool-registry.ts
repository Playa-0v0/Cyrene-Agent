// 工具註冊表 — 統一管理所有可被 LLM Router 調度的工具
// Worldbook 不在此註冊，它走獨立常駐檢索路徑

import { searchMemory } from "../rag/index";
import type { ToolRiskLevel } from "../permission";
import type { ToolContext } from "./tool-context";

/** JSON Schema 片段：參數可以是簡單類型，也可以是 array/object（含 items/properties）。 */
export type JsonSchemaProp =
  | { type: string; description?: string; enum?: string[] }
  | { type: "array"; description?: string; items: JsonSchemaProp }
  | { type: "object"; description?: string; properties: Record<string, JsonSchemaProp>; required?: string[] };

export interface ToolDefinition {
  id: string;           // 工具唯一標識，如 "imported_docs"
  name: string;         // 展示名，如 "導入文檔"
  description: string;  // 一句話描述，供 LLM Router 的 Prompt 使用
  enabled: boolean;     // 用戶是否啟用（對應設置面板的開關）
  // 危險等級：決定該工具在哪些權限檔位下可調用；不填默認 "safe"
  risk?: ToolRiskLevel;
  // MCP 兼容字段：參數 schema，後續接 MCP 時直接複用
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required?: string[];
  };
  /** 工具若聲明 needsContext，調度層執行時會傳入 ToolContext。默認不聲明=不傳。 */
  needsContext?: boolean;
  // 執行器：內置工具指向本地函數，外部 MCP 工具指向 transport 調用
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.id, tool);
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const tool = this.tools.get(id);
    if (tool) {
      tool.enabled = enabled;
    }
  }

  getEnabledTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).filter(t => t.enabled);
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getById(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }
}

// 全局單例
export const toolRegistry = new ToolRegistry();

// ── 註冊內置工具 ──────────────────────────────────────────

function formatMemoryResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as { text?: unknown; entry?: { text?: unknown } };
  if (typeof record.entry?.text === "string") return record.entry.text;
  if (typeof record.text === "string") return record.text;
  return "";
}

toolRegistry.register({
  id: 'imported_docs',
  name: '導入文檔',
  description:
    '在用戶上傳導入的文檔/小說/文件範圍內做語義檢索，返回相關片段。\n\n' +
    '何時用：\n' +
    '- 用戶提到「文件」「文檔」「小說」，或消息包含「已上傳文件」標記\n' +
    '- 用戶問的內容可能在導入的文檔裡\n' +
    '- 用戶要「在文檔裡找 xxx」「小說裡有沒有寫到 yyy」\n\n' +
    '不要用於：\n' +
    '- 本機任意路徑的文件（那是 read_file）\n' +
    '- 用戶的歷史對話記憶（那是 user_memory）\n' +
    '- 聯網信息（那是 web_search）\n\n' +
    '參數：query (必填，搜索關鍵詞)，topK (可選，返回條數，默認5)。',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索關鍵詞' },
      topK:  { type: 'number', description: '返回條數，默認5' },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const results = await searchMemory(String(args.query), 'imported_doc', Number(args.topK) || 5);
    return results.map((r: unknown) => String(r)).join('\n');
  },
});

toolRegistry.register({
  id: 'user_memory',
  name: '用戶記憶',
  description:
    '查詢用戶的歷史記憶、個人信息、過往對話中提到的事實。\n\n' +
    '何時用：\n' +
    '- 用戶說「你還記得」「我之前說過」「以前」「上次」等指代詞\n' +
    '- 用戶問自己的偏好/習慣/背景（「我喜歡什麼」「我是做什麼的」）\n' +
    '- 需要確認用戶曾經提過的具體信息\n\n' +
    '不要用於：\n' +
    '- 當前對話最近幾輪能看到的內容\n' +
    '- 導入文檔內容（那是 imported_docs）\n' +
    '- 用戶從沒提過的信息（查不到就老實說不知道）\n\n' +
    '參數：query (必填，搜索關鍵詞)，topK (可選，返回條數，默認5)。',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索關鍵詞' },
      topK:  { type: 'number', description: '返回條數，默認5' },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const results = await searchMemory(String(args.query), 'user_memory', Number(args.topK) || 5);
    return results.map(formatMemoryResult).filter(Boolean).join('\n');
  },
});

