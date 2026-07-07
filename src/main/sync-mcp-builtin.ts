// Built-in MCP auto-sync functions.
// Extracted from src/main/index.ts so vitest can import them without
// pulling in the whole Electron entry-point.

import { addMcpServer, removeMcpServer, listMcpServers } from "./orchestrator/mcp-manager";

const LOG_PREFIX = "[Cyrene]";

export const PLAYWRIGHT_MCP_ID = "playwright-mcp";
export const FIRECRAWL_HOSTED_MCP_ID = "firecrawl-hosted";

/**
 * Sync the Playwright MCP server.
 * Default OFF: opt-in via settings.playwrightMcpEnabled.
 * Stdio + npx + @playwright/mcp@latest, isolated, headless, no-sandbox.
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
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--isolated", "--headless", "--no-sandbox"],
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

/**
 * Sync the Firecrawl hosted MCP server.
 * Default ON: zero-config, keyless free tier (rate-limited).
 * SSE transport → https://mcp.firecrawl.dev/v2/mcp
 */
export async function syncFirecrawlHostedMcp(settings: {
  firecrawlHostedMcpEnabled: boolean;
}): Promise<void> {
  const exists = listMcpServers().some(s => s.id === FIRECRAWL_HOSTED_MCP_ID);

  if (settings.firecrawlHostedMcpEnabled && !exists) {
    console.log(LOG_PREFIX, "注册 Firecrawl hosted MCP Server...");
    try {
      const result = await addMcpServer({
        id: FIRECRAWL_HOSTED_MCP_ID,
        name: "Firecrawl 网页抓取",
        transport: "sse",
        url: "https://mcp.firecrawl.dev/v2/mcp",
      });
      if (result.ok) {
        console.log(LOG_PREFIX, "Firecrawl hosted MCP 注册成功,工具:", result.toolIds?.join(", "));
      } else {
        console.error(LOG_PREFIX, "Firecrawl hosted MCP 注册失败:", result.error);
      }
    } catch (err) {
      console.error(LOG_PREFIX, "Firecrawl hosted MCP 注册异常:", err);
    }
  } else if (!settings.firecrawlHostedMcpEnabled && exists) {
    console.log(LOG_PREFIX, "移除 Firecrawl hosted MCP Server...");
    try {
      await removeMcpServer(FIRECRAWL_HOSTED_MCP_ID);
    } catch (err) {
      console.error(LOG_PREFIX, "Firecrawl hosted MCP 移除异常:", err);
    }
  }
}
