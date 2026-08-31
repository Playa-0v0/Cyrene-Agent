import { describe, expect, it, vi } from "vitest";
import { createLspTool, registerLspTool } from "./lsp-tool";

describe("Code LSP tool", () => {
  it("is read-only, Code-only, and delegates only through trusted context", async () => {
    const manager = {
      execute: vi.fn(async () => ({
        serverId: "fake-lsp",
        operation: "hover" as const,
        workspaceRoot: "E:\\project",
        items: [{ contents: "value: number" }],
        message: "找到悬停信息。",
      })),
    };
    const tool = createLspTool(manager);

    expect(tool).toMatchObject({
      id: "lsp",
      modes: ["code"],
      risk: "fs-read",
      effectKind: "read",
      verificationPolicy: "none",
      needsContext: true,
    });

    const output = await tool.execute({
      operation: "hover",
      filePath: "src/app.ts",
      line: 2,
      character: 5,
    }, {
      mode: "code",
      userQuery: "查询 value 的类型",
      resolvedWorkspaceRoot: "E:\\project",
    });

    expect(JSON.parse(output)).toMatchObject({ serverId: "fake-lsp", operation: "hover" });
    expect(manager.execute).toHaveBeenCalledWith({
      operation: "hover",
      filePath: "src/app.ts",
      line: 2,
      character: 5,
      item: undefined,
      query: undefined,
    }, { resolvedWorkspaceRoot: "E:\\project" });
  });

  it("rejects non-Code contexts and model-supplied server commands", async () => {
    const tool = createLspTool({ execute: vi.fn() });

    await expect(tool.execute({ operation: "workspaceSymbol", query: "LspClient" }, { mode: "work", userQuery: "查询", resolvedWorkspaceRoot: "E:\\project" }))
      .rejects.toThrow("Code 模式");
    await expect(tool.execute({ operation: "hover", command: "powershell.exe" }, { mode: "code", userQuery: "查询", resolvedWorkspaceRoot: "E:\\project" }))
      .rejects.toThrow("不支持的 LSP 参数");
  });

  it("allows only an opaque call-hierarchy item for follow-up operations", async () => {
    const manager = { execute: vi.fn(async () => ({ serverId: "fake-lsp", operation: "incomingCalls" as const, workspaceRoot: "E:\\project", items: [], message: "" })) };
    const tool = createLspTool(manager);
    const item = { name: "value", uri: "file:///project/src/app.ts", range: {}, selectionRange: {} };

    await tool.execute({ operation: "incomingCalls", filePath: "src/app.ts", item }, { mode: "code", userQuery: "谁调用它", resolvedWorkspaceRoot: "E:\\project" });

    expect(manager.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: "incomingCalls", item }), expect.any(Object));
  });

  it("registers exactly one Code LSP tool", () => {
    const registered: string[] = [];
    registerLspTool({ execute: vi.fn() }, { register: (tool) => registered.push(tool.id) });
    expect(registered).toEqual(["lsp"]);
  });
});
