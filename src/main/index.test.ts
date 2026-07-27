import { describe, it, expect, vi, beforeEach } from "vitest";

// mock electron — sync 函數 import 時不依賴它,但防萬一
vi.mock("electron", () => ({
  app: { getPath: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

// vi.mock 工廠會被 hoist 到文件頂部,不能直接引用頂層 const;
// 用 vi.hoisted 把 mock 函數提到 mock 工廠之前。
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

import { syncPlaywrightMcp } from "./sync-mcp-builtin";

describe("syncPlaywrightMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockReturnValue([]);
  });

  it("does nothing when disabled and not connected", async () => {
    await syncPlaywrightMcp({ playwrightMcpEnabled: false });
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("adds stdio server when enabled and not connected", async () => {
    await syncPlaywrightMcp({ playwrightMcpEnabled: true });
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
      id: "playwright-mcp",
      transport: "stdio",
      command: "npx",
      args: expect.arrayContaining(["-y", "@playwright/mcp@latest"]),
    }));
  });

  it("removes when disabled and connected", async () => {
    mockList.mockReturnValue([{ id: "playwright-mcp", name: "x", connected: true, toolCount: 0, toolIds: [] }]);
    await syncPlaywrightMcp({ playwrightMcpEnabled: false });
    expect(mockRemove).toHaveBeenCalledWith("playwright-mcp");
  });

  it("no-op when enabled and already connected", async () => {
    mockList.mockReturnValue([{ id: "playwright-mcp", name: "x", connected: true, toolCount: 0, toolIds: [] }]);
    await syncPlaywrightMcp({ playwrightMcpEnabled: true });
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
