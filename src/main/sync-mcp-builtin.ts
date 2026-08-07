// Built-in MCP auto-sync functions.
// Extracted from src/main/index.ts so vitest can import them without
// pulling in the whole Electron entry-point.

import { addMcpServer, removeMcpServer, listMcpServers } from "./orchestrator/mcp-manager";
import * as path from "path";

const LOG_PREFIX = "[Cyrene]";

export const PLAYWRIGHT_MCP_ID = "playwright-mcp";

/**
 * 已下架的内置 MCP server id 列表 —— 启动时从 mcp-servers.json 中清理。
 * 仅当 id 在此名单内才会被清理，不会误删用户自定义 MCP。
 */
export const REMOVED_BUILTIN_MCP_IDS: readonly string[] = ["firecrawl-hosted"];

/**
 * Sync the Playwright MCP server.
 * Default OFF: opt-in via settings.playwrightMcpEnabled.
 * 离线化：使用本地 @playwright/mcp 的 cli.js，不再 npx 在线下载。
 * --browser msedge：自动检测系统 Edge，有头模式（用户可见）。
 */
export async function syncPlaywrightMcp(settings: {
  playwrightMcpEnabled: boolean;
}): Promise<void> {
  const exists = listMcpServers().some(s => s.id === PLAYWRIGHT_MCP_ID);

  if (settings.playwrightMcpEnabled && !exists) {
    console.log(LOG_PREFIX, "注册 Playwright MCP Server...");
    try {
      const result = await addMcpServer({
        id: PLAYWRIGHT_MCP_ID,
        name: "Playwright 浏览器",
        transport: "stdio",
        // 离线化：使用本地 cli.js；--browser msedge 代替 Chromium
        command: "node",
        args: [
          path.resolve(__dirname, "..", "..", "..", "node_modules", "@playwright", "mcp", "cli.js"),
          "--browser", "msedge", "--isolated", "--no-sandbox",
        ],
      });
      if (result.ok) {
        console.log(LOG_PREFIX, "Playwright MCP 注册成功,工具:", result.toolIds?.join(", "));
      } else {
        console.error(LOG_PREFIX, "Playwright MCP 注册失败:", result.error);
      }
    } catch (err) {
      console.error(LOG_PREFIX, "Playwright MCP 注册异常:", err);
    }
  } else if (!settings.playwrightMcpEnabled && exists) {
    console.log(LOG_PREFIX, "移除 Playwright MCP Server...");
    try {
      await removeMcpServer(PLAYWRIGHT_MCP_ID);
    } catch (err) {
      console.error(LOG_PREFIX, "Playwright MCP 移除异常:", err);
    }
  }
}
