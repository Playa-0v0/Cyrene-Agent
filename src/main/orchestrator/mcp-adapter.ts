// MCP Adapter — 将 MCP server 的工具发现和调用适配到 ToolRegistry
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolDefinition, toolRegistry } from "./tool-registry";

const LOG_PREFIX = "[MCP Adapter]";

export interface McpServerConfig {
  id: string;              // 唯一标识
  name: string;            // 展示名
  transport: "stdio" | "sse";
  command?: string;         // stdio 必填,sse 不用
  args?: string[];         // 命令行参数
  env?: Record<string, string>;
  cwd?: string;
  url?: string;            // sse 必填,stdio 不用
}

interface McpServerState {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  connected: boolean;
  toolIds: string[];       // 已注册到 ToolRegistry 的工具 ID 列表
}

/**
 * 连接一个 MCP server，发现其工具并注册到 ToolRegistry。
 * 返回注册的工具 ID 列表。
 */
export async function connectMcpServer(config: McpServerConfig): Promise<string[]> {
  console.log(LOG_PREFIX, "连接 MCP server:", config.name, "(" + config.id + ")");

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

  // 监听 transport 错误
  transport.onerror = (err: Error) => {
    console.error(LOG_PREFIX, "transport 错误 [" + config.name + "]:", err.message);
  };

  const client = new Client(
    { name: "cyrene", version: "0.8.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    console.log(LOG_PREFIX, "已连接到", config.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "连接失败 [" + config.name + "]:", msg);
    // 连接失败时清理 transport
    try { await transport.close(); } catch (_) { /* ignore */ }
    throw err;
  }

  // 发现工具
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
    console.log(LOG_PREFIX, "发现 " + mcpTools.length + " 个工具:", mcpTools.map(t => t.name).join(", "));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "listTools 失败 [" + config.name + "]:", msg);
    await client.close();
    throw err;
  }

  // 注册到 ToolRegistry
  const registeredIds: string[] = [];
  for (const mt of mcpTools) {
    // 用短横线拼接，不用冒号——Kimi 等厂商 function.name 正则不允许冒号
    // （Kimi: ^[a-zA-Z_][a-zA-Z0-9-_]$）。短横线所有厂商都接受。
    const toolId = config.id + "-" + mt.name;

    // 如果已存在同名工具，跳过
    if (toolRegistry.getById(toolId)) {
      console.warn(LOG_PREFIX, "工具已存在，跳过:", toolId);
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
      // TODO: 未来若 MCP 工具需要 ToolContext，在此将 ctx 映射为 MCP 协议 arguments 的隐藏字段。
      // 当前 MCP 工具 execute 签名不带 ctx，按需接入时改签名为 (args, ctx?) 并在这里处理。
      execute: async (args: Record<string, unknown>) => {
        console.log(LOG_PREFIX, "调用工具:", toolId, JSON.stringify(args));
        try {
          const result = await client.callTool({
            name: mt.name,
            arguments: args,
          });
          // 提取文本内容
          const texts: string[] = [];
          if (result.content && Array.isArray(result.content)) {
            for (const block of result.content) {
              if (block && typeof block === "object" && (block as { type: string }).type === "text") {
                texts.push(String((block as { text: string }).text));
              }
            }
          }
          const output = texts.join("\n") || JSON.stringify(result.content);
          if (result.isError === true) {
            throw new Error(`E_MCP_TOOL_FAILED${output ? `: ${output}` : ""}`);
          }
          console.log(LOG_PREFIX, "工具返回 [" + toolId + "]:", output.slice(0, 200));
          return output;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(LOG_PREFIX, "工具调用失败 [" + toolId + "]:", msg);
          if (msg.startsWith("E_MCP_TOOL_FAILED")) throw err;
          throw new Error(`E_MCP_TOOL_FAILED: ${msg}`);
        }
      },
    };

    toolRegistry.register(toolDef);
    registeredIds.push(toolId);
    console.log(LOG_PREFIX, "已注册工具:", toolId);
  }

  // 保存状态
  const state: McpServerState = {
    config,
    client,
    transport,
    connected: true,
    toolIds: registeredIds,
  };
  mcpServerStates.set(config.id, state);

  console.log(LOG_PREFIX, "MCP server 就绪:", config.name, "(" + registeredIds.length + " 个工具)");
  return registeredIds;
}

/**
 * 断开并清理一个 MCP server 及其注册的工具。
 */
export async function disconnectMcpServer(serverId: string): Promise<boolean> {
  console.log(LOG_PREFIX, "断开 MCP server:", serverId);
  const state = mcpServerStates.get(serverId);
  if (!state) {
    console.warn(LOG_PREFIX, "未找到 MCP server:", serverId);
    return false;
  }

  // 从 ToolRegistry 移除工具
  for (const toolId of state.toolIds) {
    toolRegistry.unregister(toolId);
    console.log(LOG_PREFIX, "已移除工具:", toolId);
  }

  try {
    await state.client.close();
    console.log(LOG_PREFIX, "已断开:", serverId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "client.close 失败 [" + serverId + "]:", msg);
    // 即使 client.close 失败，也尝试关闭 transport
    try { await state.transport.close(); } catch (_) { /* ignore */ }
  }

  state.connected = false;
  mcpServerStates.delete(serverId);
  return true;
}

/**
 * 获取所有已连接的 MCP server 状态。
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

// 内部状态存储
const mcpServerStates = new Map<string, McpServerState>();



