import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLspServer } from "./server-discovery";
import type { LspServerDefinition } from "./types";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-discovery-"));
  roots.push(root);
  return root;
}

function definition(command: string): LspServerDefinition {
  return {
    id: "test-server",
    extensions: [".test"],
    commands: [{ command, args: ["--stdio"] }],
    rootMarkers: [],
    installHint: "安装 test-server。",
  };
}

function makeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "placeholder", "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LSP server discovery", () => {
  it("prefers an explicit absolute command over local and PATH candidates", () => {
    const root = temporaryRoot();
    const explicit = path.join(root, "custom", "server.exe");
    const local = path.join(root, "node_modules", ".bin", "server.cmd");
    makeFile(explicit);
    makeFile(local);

    expect(resolveLspServer(definition(explicit), root, { PATH: "", PATHEXT: ".CMD", platform: "win32" }))
      .toMatchObject({ executablePath: explicit, args: ["--stdio"] });
  });

  it("uses a workspace-local executable before system PATH with Windows extensions", () => {
    const root = temporaryRoot();
    const local = path.join(root, "node_modules", ".bin", "test-server.cmd");
    const tools = path.join(root, "tools");
    makeFile(local);
    makeFile(path.join(tools, "test-server.exe"));

    expect(resolveLspServer(definition("test-server"), root, { PATH: tools, PATHEXT: ".EXE;.CMD", platform: "win32" }))
      .toMatchObject({ executablePath: local });
  });

  it("falls back to a system PATH executable and rejects directories", () => {
    const root = temporaryRoot();
    const tools = path.join(root, "tools");
    makeFile(path.join(tools, "test-server.exe"));
    fs.mkdirSync(path.join(root, "node_modules", ".bin", "test-server.cmd"), { recursive: true });

    expect(resolveLspServer(definition("test-server"), root, { PATH: tools, PATHEXT: ".CMD;.EXE", platform: "win32" }))
      .toMatchObject({ executablePath: path.join(tools, "test-server.exe") });
    expect(resolveLspServer(definition("missing-server"), root, { PATH: tools, PATHEXT: ".EXE", platform: "win32" }))
      .toBeNull();
  });
});
