import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createMessageConnection } from "vscode-jsonrpc/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspClient, type LspChildProcess } from "./client";
import type { ResolvedLspServer } from "./server-discovery";

const roots: string[] = [];

class FakeLspProcess extends EventEmitter implements LspChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  readonly initialized: unknown[] = [];
  readonly opened: unknown[] = [];
  readonly changed: unknown[] = [];

  constructor() {
    super();
    const server = createMessageConnection(this.stdin, this.stdout);
    server.onRequest("initialize", () => ({ capabilities: { hoverProvider: true } }));
    server.onNotification("initialized", (params: unknown) => this.initialized.push(params));
    server.onNotification("textDocument/didOpen", (params: unknown) => this.opened.push(params));
    server.onNotification("textDocument/didChange", (params: unknown) => this.changed.push(params));
    server.onRequest("shutdown", () => null);
    server.listen();
  }
}

function resolvedServer(): ResolvedLspServer {
  return {
    definition: {
      id: "fake-lsp",
      extensions: [".ts"],
      commands: [{ command: "fake-lsp", args: ["--stdio"] }],
      rootMarkers: [],
      installHint: "安装 fake-lsp。",
    },
    executablePath: "C:\\tools\\fake-lsp.exe",
    args: ["--stdio"],
  };
}

function createWorkspace(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-client-"));
  roots.push(root);
  const file = path.join(root, "src", "entry.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export const value = 1;\n", "utf8");
  return { root, file };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LspClient", () => {
  it("initializes one stdio server and synchronizes disk-backed document changes", async () => {
    const { root, file } = createWorkspace();
    const child = new FakeLspProcess();
    const spawnImpl = vi.fn(() => child);
    const client = new LspClient({ server: resolvedServer(), workspaceRoot: root, spawnImpl });

    await client.initialize();
    await client.touchFile(file, "typescript");
    fs.writeFileSync(file, "export const value = 2;\n", "utf8");
    await client.touchFile(file, "typescript");
    await client.dispose();

    expect(spawnImpl).toHaveBeenCalledWith("C:\\tools\\fake-lsp.exe", ["--stdio"], expect.objectContaining({
      cwd: root,
      shell: false,
      windowsHide: true,
    }));
    expect(child.initialized).toHaveLength(1);
    expect(child.opened).toHaveLength(1);
    expect(child.changed).toHaveLength(1);
    expect(child.kill).toHaveBeenCalled();
  });

  it("rejects a cancelled request without disposing the shared server", async () => {
    const { root } = createWorkspace();
    const child = new FakeLspProcess();
    const client = new LspClient({ server: resolvedServer(), workspaceRoot: root, spawnImpl: () => child });
    const controller = new AbortController();
    controller.abort();

    await expect(client.request("textDocument/hover", {}, 10_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).not.toHaveBeenCalled();
  });
});
