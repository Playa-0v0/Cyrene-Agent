import { LspManager, type LspExecutionContext } from "../lsp/manager";
import { LSP_OPERATIONS, type LspOperation, type LspQuery } from "../lsp/types";
import type { ToolContext } from "./tool-context";
import type { ToolDefinition } from "./tool-registry";

type LspManagerPort = Pick<LspManager, "execute">;

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} 必须是非空字符串`);
  return value.trim();
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${key} 必须是从 1 开始的整数`);
  return value as number;
}

function requireCodeWorkspace(ctx: ToolContext | undefined): LspExecutionContext {
  if (ctx?.mode !== "code") throw new Error("LSP 工具只允许在 Code 模式使用");
  if (!ctx.resolvedWorkspaceRoot) throw new Error("当前 Code 对话尚未绑定工作目录");
  return { resolvedWorkspaceRoot: ctx.resolvedWorkspaceRoot, signal: ctx.signal };
}

function parseQuery(args: Record<string, unknown>): LspQuery {
  const allowedKeys = new Set(["operation", "filePath", "line", "character", "query", "item"]);
  if (Object.keys(args).some((key) => !allowedKeys.has(key))) throw new Error("不支持的 LSP 参数");
  if (typeof args.operation !== "string" || !LSP_OPERATIONS.includes(args.operation as LspOperation)) {
    throw new Error("operation 必须是受支持的 LSP 操作");
  }
  return {
    operation: args.operation as LspOperation,
    filePath: stringArg(args, "filePath"),
    line: optionalPositiveInteger(args, "line"),
    character: optionalPositiveInteger(args, "character"),
    query: stringArg(args, "query"),
    item: parseCallHierarchyItem(args.item),
  };
}

function parseCallHierarchyItem(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("item 必须是调用层级条目对象");
  return value as Record<string, unknown>;
}

export function createLspTool(manager: LspManagerPort): ToolDefinition {
  return {
    id: "lsp",
    name: "代码语义查询",
    description: "仅在 Code 模式中，通过用户已安装的语言服务器查询定义、引用、悬停、符号和诊断；不会修改文件或安装软件。",
    enabled: true,
    modes: ["code"],
    risk: "fs-read",
    effectKind: "read",
    verificationPolicy: "none",
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: [...LSP_OPERATIONS], description: "语义查询类型" },
        filePath: { type: "string", description: "绑定工作目录内的相对文件路径；workspaceSymbol 不需要。" },
        line: { type: "number", description: "从 1 开始的行号；位置类操作需要。" },
        character: { type: "number", description: "从 1 开始的字符号；位置类操作需要。" },
        query: { type: "string", description: "workspaceSymbol 的搜索词。" },
        item: { type: "object", description: "仅 incomingCalls/outgoingCalls 使用：prepareCallHierarchy 返回的条目。" },
      },
      required: ["operation"],
    },
    execute: async (args, ctx) => JSON.stringify(await manager.execute(parseQuery(args), requireCodeWorkspace(ctx))),
  };
}

export function registerLspTool(
  manager: LspManagerPort,
  registry: Pick<import("./tool-registry").ToolRegistry, "register">,
): void {
  registry.register(createLspTool(manager));
}
