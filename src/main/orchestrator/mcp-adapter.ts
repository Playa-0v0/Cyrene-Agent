// MCP Adapter — 將 MCP server 的工具發現和調用適配到 ToolRegistry
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolDefinition, toolRegistry } from "./tool-registry";

const LOG_PREFIX = "[MCP Adapter]";

export interface McpServerConfig {
  id: string;              // 唯一標識
  name: string;            // 展示名
  transport: "stdio" | "sse";
  command?: string;         // stdio 必填,sse 不用
  args?: string[];         // 命令行參數
  env?: Record<string, string>;
  cwd?: string;
  url?: string;            // sse 必填,stdio 不用
}

interface McpServerState {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  connected: boolean;
  toolIds: string[];       // 已註冊到 ToolRegistry 的工具 ID 列表
}

/**
 * 連接一個 MCP server，發現其工具並註冊到 ToolRegistry。
 * 返回註冊的工具 ID 列表。
 */
export async function connectMcpServer(config: McpServerConfig): Promise<string[]> {
  console.log(LOG_PREFIX, "連接 MCP server:", config.name, "(" + config.id + ")");

  let transport: Transport;
  if (config.transport === "sse") {
    if (!config.url) {
      throw new Error("sse transport requires url");
    }
    transport = new SSEClientTransport(new URL(config.url));
  } else {
    if (!config.command) {
      throw new Error("stdio transport requires command");
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    });
  }

  // 監聽 transport 錯誤
  transport.onerror = (err: Error) => {
    console.error(LOG_PREFIX, "transport 錯誤 [" + config.name + "]:", err.message);
  };

  const client = new Client(
    { name: "cyrene", version: "0.1.1" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    console.log(LOG_PREFIX, "已連接到", config.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "連接失敗 [" + config.name + "]:", msg);
    // 連接失敗時清理 transport
    try { await transport.close(); } catch (_) { /* ignore */ }
    throw err;
  }

  // 發現工具
  let mcpTools: Array<{
    name: string;
    description?: string;
    inputSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  }> = [];

  try {
    const result = await client.listTools();
    mcpTools = result.tools as Array<{
      name: string;
      description?: string;
      inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
      };
    }>;
    console.log(LOG_PREFIX, "發現 " + mcpTools.length + " 個工具:", mcpTools.map(t => t.name).join(", "));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "listTools 失敗 [" + config.name + "]:", msg);
    await client.close();
    throw err;
  }

  // 註冊到 ToolRegistry
  const registeredIds: string[] = [];
  for (const mt of mcpTools) {
    // 用短橫線拼接，不用冒號——Kimi 等廠商 function.name 正則不允許冒號
    // （Kimi: ^[a-zA-Z_][a-zA-Z0-9-_]$）。短橫線所有廠商都接受。
    const toolId = config.id + "-" + mt.name;

    // 如果已存在同名工具，跳過
    if (toolRegistry.getById(toolId)) {
      console.warn(LOG_PREFIX, "工具已存在，跳過:", toolId);
      continue;
    }

    const toolDef: ToolDefinition = {
      id: toolId,
      name: "[" + config.name + "] " + mt.name,
      description: mt.description || mt.name,
      enabled: true,
      inputSchema: {
        type: "object",
        properties: mt.inputSchema?.properties as Record<string, { type: string; description: string }> || {},
        required: mt.inputSchema?.required,
      },
      // TODO: 未來若 MCP 工具需要 ToolContext，在此將 ctx 映射為 MCP 協議 arguments 的隱藏字段。
      // 當前 MCP 工具 execute 簽名不帶 ctx，按需接入時改簽名為 (args, ctx?) 並在這裡處理。
      execute: async (args: Record<string, unknown>) => {
        console.log(LOG_PREFIX, "調用工具:", toolId, JSON.stringify(args));
        try {
          const result = await client.callTool({
            name: mt.name,
            arguments: args,
          });
          // 提取文本內容
          const texts: string[] = [];
          if (result.content && Array.isArray(result.content)) {
            for (const block of result.content) {
              if (block && typeof block === "object" && (block as { type: string }).type === "text") {
                texts.push(String((block as { text: string }).text));
              }
            }
          }
          const output = texts.join("\n") || JSON.stringify(result.content);
          console.log(LOG_PREFIX, "工具返回 [" + toolId + "]:", output.slice(0, 200));
          return output;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(LOG_PREFIX, "工具調用失敗 [" + toolId + "]:", msg);
          return "[MCP 工具調用失敗] " + msg;
        }
      },
    };

    toolRegistry.register(toolDef);
    registeredIds.push(toolId);
    console.log(LOG_PREFIX, "已註冊工具:", toolId);
  }

  // 保存狀態
  const state: McpServerState = {
    config,
    client,
    transport,
    connected: true,
    toolIds: registeredIds,
  };
  mcpServerStates.set(config.id, state);

  console.log(LOG_PREFIX, "MCP server 就緒:", config.name, "(" + registeredIds.length + " 個工具)");
  return registeredIds;
}

/**
 * 斷開並清理一個 MCP server 及其註冊的工具。
 */
export async function disconnectMcpServer(serverId: string): Promise<boolean> {
  console.log(LOG_PREFIX, "斷開 MCP server:", serverId);
  const state = mcpServerStates.get(serverId);
  if (!state) {
    console.warn(LOG_PREFIX, "未找到 MCP server:", serverId);
    return false;
  }

  // 從 ToolRegistry 移除工具
  for (const toolId of state.toolIds) {
    toolRegistry.unregister(toolId);
    console.log(LOG_PREFIX, "已移除工具:", toolId);
  }

  try {
    await state.client.close();
    console.log(LOG_PREFIX, "已斷開:", serverId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "client.close 失敗 [" + serverId + "]:", msg);
    // 即使 client.close 失敗，也嘗試關閉 transport
    try { await state.transport.close(); } catch (_) { /* ignore */ }
  }

  state.connected = false;
  mcpServerStates.delete(serverId);
  return true;
}

/**
 * 獲取所有已連接的 MCP server 狀態。
 */
export function getMcpServerStates(): Array<{
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  toolIds: string[];
}> {
  return Array.from(mcpServerStates.values()).map(s => ({
    id: s.config.id,
    name: s.config.name,
    connected: s.connected,
    toolCount: s.toolIds.length,
    toolIds: [...s.toolIds],
  }));
}

// 內部狀態存儲
const mcpServerStates = new Map<string, McpServerState>();



