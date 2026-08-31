import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspManager } from "./manager";
import type { ResolvedLspServer } from "./server-discovery";
import type { LspServerDefinition, LspServerOverride } from "./types";

const roots: string[] = [];

function workspace(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-manager-"));
  roots.push(root);
  const file = path.join(root, "src", "entry.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export const value = 1;\n", "utf8");
  return { root, file };
}

const resolvedServer: ResolvedLspServer = {
  definition: { id: "fake-lsp", extensions: [".ts"], commands: [{ command: "fake", args: [] }], rootMarkers: [], installHint: "安装 fake。" },
  executablePath: "C:\\tools\\fake.exe",
  args: [],
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LspManager", () => {
  it("reuses one workspace server and maps one-based hover positions", async () => {
    const { root, file } = workspace();
    const client = {
      initialize: vi.fn(async () => {}),
      touchFile: vi.fn(async () => {}),
      request: vi.fn(async () => ({ contents: "value: number" })),
      getDiagnostics: vi.fn(() => []),
      dispose: vi.fn(async () => {}),
    };
    const createClient = vi.fn(() => client);
    const manager = new LspManager({
      resolveServer: () => resolvedServer,
      createClient,
    });

    const first = await manager.execute({ operation: "hover", filePath: file, line: 3, character: 4 }, { resolvedWorkspaceRoot: root });
    const second = await manager.execute({ operation: "hover", filePath: file, line: 3, character: 4 }, { resolvedWorkspaceRoot: root });

    expect(first.items).toEqual([{ contents: "value: number" }]);
    expect(second.serverId).toBe("fake-lsp");
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.touchFile).toHaveBeenCalledWith(file, "typescript");
    expect(client.request).toHaveBeenCalledWith("textDocument/hover", expect.objectContaining({ position: { line: 2, character: 3 } }));
  });

  it("rejects external paths before server discovery", async () => {
    const { root } = workspace();
    const resolveServer = vi.fn(() => resolvedServer);
    const manager = new LspManager({ resolveServer, createClient: vi.fn() });

    await expect(manager.execute({ operation: "hover", filePath: path.join(root, "..", "other.ts"), line: 1, character: 1 }, { resolvedWorkspaceRoot: root }))
      .rejects.toMatchObject({ code: "LSP_PATH_OUTSIDE_WORKSPACE" });
    expect(resolveServer).not.toHaveBeenCalled();
  });

  it("uses persisted user overrides before resolving the built-in server", async () => {
    const { root, file } = workspace();
    const overrides: LspServerOverride[] = [{
      id: "typescript-language-server",
      command: "custom-ts-lsp",
      args: ["--stdio", "--log-level=3"],
    }];
    const resolveServer = vi.fn((definition: LspServerDefinition) => ({
      ...resolvedServer,
      definition,
      executablePath: "C:\\tools\\custom-ts-lsp.exe",
      args: definition.commands[0].args,
    }));
    const client = {
      initialize: vi.fn(async () => {}), touchFile: vi.fn(async () => {}),
      request: vi.fn(async () => null), getDiagnostics: vi.fn(() => []), dispose: vi.fn(async () => {}),
    };
    const manager = new LspManager({
      getServerOverrides: () => overrides,
      resolveServer,
      createClient: () => client,
    });

    await manager.execute({ operation: "hover", filePath: file, line: 1, character: 1 }, { resolvedWorkspaceRoot: root });

    expect(resolveServer).toHaveBeenCalledWith(expect.objectContaining({
      id: "typescript-language-server",
      commands: [{ command: "custom-ts-lsp", args: ["--stdio", "--log-level=3"] }],
    }), root);
  });

  it("forwards an item selected from prepareCallHierarchy to incomingCalls", async () => {
    const { root, file } = workspace();
    const client = {
      initialize: vi.fn(async () => {}), touchFile: vi.fn(async () => {}),
      request: vi.fn(async () => []), getDiagnostics: vi.fn(() => []), dispose: vi.fn(async () => {}),
    };
    const manager = new LspManager({ resolveServer: () => resolvedServer, createClient: () => client });
    const item = { name: "value", uri: "file:///workspace/src/entry.ts", range: {}, selectionRange: {} };

    await manager.execute({ operation: "incomingCalls", filePath: file, item }, { resolvedWorkspaceRoot: root });

    expect(client.request).toHaveBeenCalledWith("callHierarchy/incomingCalls", { item });
  });

  it("forwards parent cancellation to the semantic request", async () => {
    const { root, file } = workspace();
    const client = {
      initialize: vi.fn(async () => {}), touchFile: vi.fn(async () => {}),
      request: vi.fn(async () => null), getDiagnostics: vi.fn(() => []), dispose: vi.fn(async () => {}),
    };
    const manager = new LspManager({ resolveServer: () => resolvedServer, createClient: () => client });
    const controller = new AbortController();

    await manager.execute({ operation: "hover", filePath: file, line: 1, character: 1 }, { resolvedWorkspaceRoot: root, signal: controller.signal });

    expect(client.request).toHaveBeenCalledWith("textDocument/hover", expect.any(Object), undefined, controller.signal);
  });
});
