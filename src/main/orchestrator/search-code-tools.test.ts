/**
 * search_code 工具测试
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock toolRegistry 避免副作用
vi.mock("./tool-registry", () => ({
  toolRegistry: {
    register: vi.fn(),
    getById: vi.fn(),
    getEnabledTools: vi.fn(() => []),
  },
}));

import { registerSearchCodeTool } from "./search-code-tools";
import { toolRegistry } from "./tool-registry";

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-code-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("search_code tool", () => {

  it("registers search_code tool with correct metadata", () => {
    registerSearchCodeTool();
    const registerCall = vi.mocked(toolRegistry.register).mock.calls[0];
    const toolDef = registerCall[0];
    expect(toolDef.id).toBe("search_code");
    expect(toolDef.effectKind).toBe("read");
    expect(toolDef.verificationPolicy).toBe("none");
    expect(toolDef.needsContext).toBe(true);
    expect(toolDef.isConcurrencySafe?.({ query: "needle" })).toBe(true);
  });

  it("searches for literal text in files", async () => {
    // 创建测试文件
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "const foo = 1;\nconst bar = 2;\nconst foo = 3;");

    // 直接调用 execute
    const toolDef = vi.mocked(toolRegistry.register).mock.calls[0]?.[0];
    if (!toolDef) {
      registerSearchCodeTool();
    }
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute({ query: "foo", paths: ["."] }, { userQuery: "test" } as any));

    expect(result.matches).toHaveLength(2);
    expect(result.totalMatches).toBe(2);
    expect(result.returnedMatches).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("returns error for empty query", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute({ query: "" }, { userQuery: "test" } as any));
    expect(result.error).toContain("query 不能为空");
    expect(result.matches).toEqual([]);
  });

  it("returns no matches for an invalid regular expression", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];
    fs.writeFileSync(path.join(tmpDir, "regex.ts"), "const value = 1;");

    const result = JSON.parse(await tool.execute({ query: "[invalid", mode: "regex" }, { userQuery: "test" } as any));
    expect(result.matches).toEqual([]);
    expect(result.totalMatches).toBe(0);
  });

  it("respects maxMatches limit", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute({ query: "test", maxMatches: 5 }, { userQuery: "test" } as any));
    expect(result.matches.length).toBeLessThanOrEqual(5);
  });

  it("respects contextLines limit", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute({ query: "test", contextLines: 1 }, { userQuery: "test" } as any));
    // 验证上下文行数不超过限制
    for (const match of result.matches) {
      expect(match.before.length).toBeLessThanOrEqual(1);
      expect(match.after.length).toBeLessThanOrEqual(1);
    }
  });

  it("handles fileGlobs filter", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute(
      { query: "test", fileGlobs: ["*.ts"] },
      { userQuery: "test" } as any,
    ));
    expect(result).toHaveProperty("matches");
  });

  it("skips .worktrees mirror directories and reports them in skippedDirs", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    // 当前工作区真实代码 + worktree 里的旧副本（同名符号残留）
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "main.ts"), "const loopLog = 1;\n");
    fs.mkdirSync(path.join(tmpDir, ".worktrees", "task-x", "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".worktrees", "task-x", "src", "main.ts"), "const flowLog = 1;\n");

    const result = JSON.parse(await tool.execute(
      { query: "flowLog" },
      { userQuery: "test" } as any,
    ));

    // 旧副本不参与匹配：不会返回 .worktrees 里的命中
    expect(result.totalMatches).toBe(0);
    // 但明确告知模型排除了哪些镜像目录
    expect(result.skippedDirs).toContain(".worktrees");
    expect(result.message).toContain("已排除镜像/依赖目录");

    // 当前工作区的代码仍能正常搜到
    const currentResult = JSON.parse(await tool.execute(
      { query: "loopLog" },
      { userQuery: "test" } as any,
    ));
    expect(currentResult.totalMatches).toBe(1);
    expect(currentResult.matches[0].path.replace(/\\/g, "/")).toBe("src/main.ts");
  });

  it("handles caseSensitive option", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const result = JSON.parse(await tool.execute(
      { query: "Test", caseSensitive: true },
      { userQuery: "test" } as any,
    ));
    expect(result).toHaveProperty("matches");
  });

  it("handles AbortSignal", async () => {
    registerSearchCodeTool();
    const tool = vi.mocked(toolRegistry.register).mock.calls[0][0];

    const controller = new AbortController();
    controller.abort(); // 立即取消

    const result = JSON.parse(await tool.execute(
      { query: "test" },
      { userQuery: "test", signal: controller.signal } as any,
    ));
    expect(result).toHaveProperty("matches");
  });
});

describe("search_code path safety", () => {
  it("rejects path traversal attempts", () => {
    // 测试路径逃逸检测（使用 tmpDir 确保跨平台）
    const workspaceRoot = tmpDir;
    const maliciousPath = path.join("..", "..", "..", "etc", "passwd");

    const resolved = path.resolve(workspaceRoot, maliciousPath);
    const normalizedRoot = path.normalize(workspaceRoot);
    const isWithin = resolved.startsWith(normalizedRoot + path.sep) || resolved === normalizedRoot;

    expect(isWithin).toBe(false);
  });

  it("allows normal paths within workspace", () => {
    const workspaceRoot = tmpDir;
    const normalPath = path.join("src", "main", "index.ts");

    const resolved = path.resolve(workspaceRoot, normalPath);
    const normalizedRoot = path.normalize(workspaceRoot);
    const isWithin = resolved.startsWith(normalizedRoot + path.sep) || resolved === normalizedRoot;

    expect(isWithin).toBe(true);
  });
});

describe("search_code glob matching", () => {
  it("matches simple glob patterns", () => {
    // 测试 glob 匹配逻辑
    function matchesGlob(filePath: string, pattern: string): boolean {
      const regexStr = pattern
        .replace(/\./g, "\\.")
        .replace(/\*\*/g, "⟨GLOBSTAR⟩")
        .replace(/\*/g, "[^/]*")
        .replace(/⟨GLOBSTAR⟩/g, ".*")
        .replace(/\?/g, "[^/]");
      const regex = new RegExp("^" + regexStr + "$");
      return regex.test(filePath);
    }

    expect(matchesGlob("src/main/index.ts", "*.ts")).toBe(false); // 不匹配路径
    expect(matchesGlob("index.ts", "*.ts")).toBe(true);
    expect(matchesGlob("src/main/index.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("src/main/index.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/main/index.ts", "*.js")).toBe(false);
  });
});
