import { describe, it, expect, vi, beforeEach } from "vitest";

// mock electron — sync 函数 import 时不依赖它,但防万一
vi.mock("electron", () => ({
  app: { getPath: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

// vi.mock 工厂会被 hoist 到文件顶部,不能直接引用顶层 const;
// 用 vi.hoisted 把 mock 函数提到 mock 工厂之前。
const { mockAdd, mockRemove, mockList } = vi.hoisted(() => ({
  mockAdd: vi.fn().mockResolvedValue({ ok: true, toolIds: [] }),
  mockRemove: vi.fn().mockResolvedValue({ ok: true }),
  mockList: vi.fn().mockReturnValue([]),
}));

vi.mock("./orchestrator/mcp-manager", () => ({
  addMcpServer: mockAdd,
  removeMcpServer: mockRemove,
  listMcpServers: mockList,
}));

import { syncPlaywrightMcp, syncFirecrawlHostedMcp } from "./sync-mcp-builtin";

describe("syncPlaywrightMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockReturnValue([]);
  });

  it("does nothing when disabled and not connected", async () => {
    await syncPlaywrightMcp({ playwrightMcpEnabled: false } as any);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("adds stdio server when enabled and not connected", async () => {
    await syncPlaywrightMcp({ playwrightMcpEnabled: true } as any);
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
      id: "playwright-mcp",
      transport: "stdio",
      command: "npx",
      args: expect.arrayContaining(["-y", "@playwright/mcp@latest"]),
    }));
  });

  it("removes when disabled and connected", async () => {
    mockList.mockReturnValue([{ id: "playwright-mcp", name: "x", connected: true, toolCount: 0, toolIds: [] }]);
    await syncPlaywrightMcp({ playwrightMcpEnabled: false } as any);
    expect(mockRemove).toHaveBeenCalledWith("playwright-mcp");
  });

  it("no-op when enabled and already connected", async () => {
    mockList.mockReturnValue([{ id: "playwright-mcp", name: "x", connected: true, toolCount: 0, toolIds: [] }]);
    await syncPlaywrightMcp({ playwrightMcpEnabled: true } as any);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

describe("syncFirecrawlHostedMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockReturnValue([]);
  });

  it("adds sse server when enabled and not connected", async () => {
    await syncFirecrawlHostedMcp({ firecrawlHostedMcpEnabled: true } as any);
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
      id: "firecrawl-hosted",
      transport: "sse",
      url: "https://mcp.firecrawl.dev/v2/mcp",
    }));
  });

  it("removes when disabled and connected", async () => {
    mockList.mockReturnValue([{ id: "firecrawl-hosted", name: "x", connected: true, toolCount: 0, toolIds: [] }]);
    await syncFirecrawlHostedMcp({ firecrawlHostedMcpEnabled: false } as any);
    expect(mockRemove).toHaveBeenCalledWith("firecrawl-hosted");
  });
});
