// Built-in MCP auto-sync functions.
// Extracted from src/main/index.ts so vitest can import them without
// pulling in the whole Electron entry-point.

import { addMcpServer, removeMcpServer, listMcpServers, hasMcpServerConfig } from "./orchestrator/mcp-manager";

const LOG_PREFIX = "[Cyrene]";

export const PLAYWRIGHT_MCP_ID = "playwright-mcp";

/**
 * 已下架的內置 MCP server id 列表 —— 啟動時從 mcp-servers.json 中清理。
 * 僅當 id 在此名單內才會被清理，不會誤刪用戶自定義 MCP。
 */
export const REMOVED_BUILTIN_MCP_IDS: readonly string[] = ["firecrawl-hosted"];

/**
 * Sync the Playwright MCP server.
 * Default OFF: opt-in via settings.playwrightMcpEnabled.
 * Stdio + npx + @playwright/mcp@latest, isolated, headless, no-sandbox.
 */
export async function syncPlaywrightMcp(settings: {
  playwrightMcpEnabled: boolean;
}): Promise<void> {
  // 啟動早期 persisted config 已存在、但 MCP Manager 尚未連線時，
  // listMcpServers() 仍是空的；兩邊都檢查可避免重複 add。
  const exists = hasMcpServerConfig(PLAYWRIGHT_MCP_ID)
    || listMcpServers().some(s => s.id === PLAYWRIGHT_MCP_ID);

  if (settings.playwrightMcpEnabled && !exists) {
    console.log(LOG_PREFIX, "註冊 Playwright MCP Server...");
    try {
      const result = await addMcpServer({
        id: PLAYWRIGHT_MCP_ID,
        name: "Playwright 瀏覽器",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--isolated", "--headless", "--no-sandbox"],
      });
      if (result.ok) {
        console.log(LOG_PREFIX, "Playwright MCP 註冊成功,工具:", result.toolIds?.join(", "));
      } else {
        console.error(LOG_PREFIX, "Playwright MCP 註冊失敗:", result.error);
      }
    } catch (err) {
      console.error(LOG_PREFIX, "Playwright MCP 註冊異常:", err);
    }
  } else if (!settings.playwrightMcpEnabled && exists) {
    console.log(LOG_PREFIX, "移除 Playwright MCP Server...");
    try {
      await removeMcpServer(PLAYWRIGHT_MCP_ID);
    } catch (err) {
      console.error(LOG_PREFIX, "Playwright MCP 移除異常:", err);
    }
  }
}
