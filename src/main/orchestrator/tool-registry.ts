// 工具注册表 — 统一管理所有可被 LLM Router 调度的工具
// Worldbook 不在此注册，它走独立常驻检索路径

import { searchMemory } from "../rag/index";
import type { ToolRiskLevel } from "../permission";
import type { ToolContext } from "./tool-context";

/** JSON Schema 片段：参数可以是简单类型，也可以是 array/object（含 items/properties）。 */
export type JsonSchemaProp =
  | { type: string; description?: string; enum?: string[] }
  | { type: "array"; description?: string; items: JsonSchemaProp }
  | { type: "object"; description?: string; properties: Record<string, JsonSchemaProp>; required?: string[] };

export interface ToolDefinition {
  id: string;           // 工具唯一标识，如 "imported_docs"
  name: string;         // 展示名，如 "导入文档"
  description: string;  // 一句话描述，供 LLM Router 的 Prompt 使用
  enabled: boolean;     // 用户是否启用（对应设置面板的开关）
  // 危险等级：决定该工具在哪些权限档位下可调用；不填默认 "safe"
  risk?: ToolRiskLevel;
  // MCP 兼容字段：参数 schema，后续接 MCP 时直接复用
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required?: string[];
  };
  /** 工具若声明 needsContext，调度层执行时会传入 ToolContext。默认不声明=不传。 */
  needsContext?: boolean;
  // 执行器：内置工具指向本地函数，外部 MCP 工具指向 transport 调用
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

// 全局单例
export const toolRegistry = new ToolRegistry();

// ── 注册内置工具 ──────────────────────────────────────────

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
  name: '导入文档',
  description:
    '在用户上传导入的文档/小说/文件范围内做语义检索，返回相关片段。\n\n' +
    '何时用：\n' +
    '- 用户提到「文件」「文档」「小说」，或消息包含「已上传文件」标记\n' +
    '- 用户问的内容可能在导入的文档里\n' +
    '- 用户要「在文档里找 xxx」「小说里有没有写到 yyy」\n\n' +
    '不要用于：\n' +
    '- 本机任意路径的文件（那是 read_file）\n' +
    '- 用户的历史对话记忆（那是 user_memory）\n' +
    '- 联网信息（那是 web_search）\n\n' +
    '参数：query (必填，搜索关键词)，topK (可选，返回条数，默认5)。',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      topK:  { type: 'number', description: '返回条数，默认5' },
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
  name: '用户记忆',
  description:
    '查询用户的历史记忆、个人信息、过往对话中提到的事实。\n\n' +
    '何时用：\n' +
    '- 用户说「你还记得」「我之前说过」「以前」「上次」等指代词\n' +
    '- 用户问自己的偏好/习惯/背景（「我喜欢什么」「我是做什么的」）\n' +
    '- 需要确认用户曾经提过的具体信息\n\n' +
    '不要用于：\n' +
    '- 当前对话最近几轮能看到的内容\n' +
    '- 导入文档内容（那是 imported_docs）\n' +
    '- 用户从没提过的信息（查不到就老实说不知道）\n\n' +
    '参数：query (必填，搜索关键词)，topK (可选，返回条数，默认5)。',
  enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      topK:  { type: 'number', description: '返回条数，默认5' },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const results = await searchMemory(String(args.query), 'user_memory', Number(args.topK) || 5);
    return results.map(formatMemoryResult).filter(Boolean).join('\n');
  },
});

