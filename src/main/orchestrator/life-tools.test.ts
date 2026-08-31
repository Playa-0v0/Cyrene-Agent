/**
 * str_replace 失败诊断测试
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

// Mock built-in-tools 避免 electron 依赖
vi.mock("./built-in-tools", () => ({}));

// Mock fetch 避免翻译工具的网络调用
globalThis.fetch = vi.fn() as any;

// 直接测试 str_replace 的逻辑，不导入整个 life-tools
// 因为 life-tools 依赖 electron 的 ipcMain

// 提取 str_replace 核心逻辑用于测试
interface MatchPosition {
  line: number;
  context: string;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const c of setA) {
    if (setB.has(c)) intersection++;
  }
  return intersection / Math.max(setA.size, setB.size);
}

function findNearestMatch(
  lines: string[],
  oldStr: string,
): { line: number; similarity: number; context: string } | null {
  const oldLines = oldStr.split("\n");
  const firstLine = oldLines[0]?.trim() || "";
  if (!firstLine) return null;

  let bestMatch: { line: number; sim: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sim = similarity(firstLine, line.trim());
    if (sim > 0.5 && (!bestMatch || sim > bestMatch.sim)) {
      bestMatch = { line: i + 1, sim };
    }
  }

  if (!bestMatch) return null;

  const contextStart = Math.max(0, bestMatch.line - 3);
  const contextEnd = Math.min(lines.length, bestMatch.line + 2);
  const contextLines = lines.slice(contextStart, contextEnd).map((l, idx) => {
    const ln = contextStart + idx + 1;
    const marker = ln === bestMatch!.line ? ">" : " ";
    return `${marker} ${String(ln).padStart(4)} | ${l}`;
  });

  return {
    line: bestMatch.line,
    similarity: bestMatch.sim,
    context: contextLines.join("\n"),
  };
}

function findAllMatchPositions(lines: string[], oldStr: string): MatchPosition[] {
  const positions: MatchPosition[] = [];
  const oldLines = oldStr.split("\n");
  const firstLine = oldLines[0] || "";

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(firstLine)) {
      const candidate = lines.slice(i, i + oldLines.length).join("\n");
      if (candidate === oldStr) {
        const contextStart = Math.max(0, i - 2);
        const contextEnd = Math.min(lines.length, i + oldLines.length + 2);
        const contextLines = lines.slice(contextStart, contextEnd).map((l, idx) => {
          const ln = contextStart + idx + 1;
          const marker = (ln >= i + 1 && ln <= i + oldLines.length) ? ">" : " ";
          return `${marker} ${String(ln).padStart(4)} | ${l}`;
        });

        positions.push({
          line: i + 1,
          context: contextLines.join("\n"),
        });
      }
    }
  }

  return positions;
}

/** 模拟 str_replace 执行 */
function executeStrReplace(filePath: string, oldStr: string, newStr: string): any {
  if (!filePath) return { error: "file_path 不能为空", success: false };
  if (!fs.existsSync(filePath)) return { error: `文件不存在：${filePath}`, success: false };

  const content = fs.readFileSync(filePath, "utf8");
  if (!oldStr) return { error: "old_string 不能为空", success: false };

  // EOL 归一化（与 life-tools.ts 真实实现保持一致）
  let matchStr = oldStr;
  let replaceStr = newStr;
  if (content.includes("\r\n") && !oldStr.includes("\r")) {
    matchStr = oldStr.replaceAll("\n", "\r\n");
    replaceStr = newStr.replaceAll("\n", "\r\n");
  } else if (!content.includes("\r\n") && oldStr.includes("\r\n")) {
    matchStr = oldStr.replaceAll("\r\n", "\n");
    replaceStr = newStr.replaceAll("\r\n", "\n");
  }
  const eolNormalized = matchStr !== oldStr;

  const lines = content.split("\n");
  const count = content.split(matchStr).length - 1;

  if (count === 0) {
    const nearest = findNearestMatch(lines, oldStr);
    return {
      error: "old_string 在文件中未找到。请确认内容（包括缩进、换行）是否精确匹配。",
      success: false,
      diagnostic: {
        kind: "not_found",
        filePath,
        oldStringLength: oldStr.length,
        nearestMatch: nearest ? {
          line: nearest.line,
          similarity: nearest.similarity,
          context: nearest.context,
        } : null,
      },
    };
  }

  if (count > 1) {
    const positions = findAllMatchPositions(lines, oldStr);
    return {
      error: `old_string 在文件中匹配 ${count} 处，需要更长的上下文使其唯一。`,
      success: false,
      diagnostic: {
        kind: "multiple_matches",
        filePath,
        matchCount: count,
        positions: positions.slice(0, 5).map(pos => ({
          line: pos.line,
          context: pos.context,
        })),
      },
    };
  }

  const newContent = content.replace(matchStr, replaceStr);
  fs.writeFileSync(filePath, newContent, "utf8");
  const size = fs.statSync(filePath).size;
  return {
    tool: "str_replace",
    filePath,
    action: "modified",
    sizeBytes: size,
    success: true,
    eolNormalized,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-tools-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("str_replace success", () => {
  it("applies patch successfully", async () => {
    const testFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(testFile, "const a = 1;\nconst b = 2;\nconst c = 3;");

    const result = executeStrReplace(testFile, "const b = 2;", "const b = 42;");

    expect(result.success).toBe(true);
    expect(result.action).toBe("modified");
    expect(fs.readFileSync(testFile, "utf8")).toContain("const b = 42;");
  });

  it("matches LF old_string against a CRLF file and preserves CRLF on write", async () => {
    const testFile = path.join(tmpDir, "crlf.ts");
    // Windows 文件 CRLF；模型给的 old_string/new_string 是 LF
    fs.writeFileSync(testFile, "function init() {\r\n  const flowLog = 1;\r\n  return flowLog;\r\n}\r\n");

    const result = executeStrReplace(
      testFile,
      "  const flowLog = 1;\n  return flowLog;",
      "  const loopLog = 1;\n  return loopLog;",
    );

    expect(result.success).toBe(true);
    expect(result.eolNormalized).toBe(true);
    // 写回保持 CRLF，不出现混合 EOL
    expect(fs.readFileSync(testFile, "utf8"))
      .toBe("function init() {\r\n  const loopLog = 1;\r\n  return loopLog;\r\n}\r\n");
  });
});

describe("str_replace failure diagnostics", () => {
  it("returns structured diagnostic when old_string not found", async () => {
    const testFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(testFile, "const foo = 1;\nconst bar = 2;\nconst baz = 3;");

    const result = executeStrReplace(testFile, "const qux = 999;", "const qux = 42;");

    expect(result.success).toBe(false);
    expect(result.error).toContain("未找到");
    expect(result.diagnostic).toBeDefined();
    expect(result.diagnostic.kind).toBe("not_found");
    expect(result.diagnostic.filePath).toBe(testFile);
    expect(result.diagnostic.oldStringLength).toBe(16);
  });

  it("provides nearest match when old_string not found", async () => {
    const testFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(testFile, "const foo = 1;\nconst bar = 2;\nconst baz = 3;");

    const result = executeStrReplace(testFile, "const foo = 999;", "const foo = 42;");

    expect(result.success).toBe(false);
    expect(result.diagnostic.kind).toBe("not_found");
    // 应该找到最接近的 "const foo = 1;"
    expect(result.diagnostic.nearestMatch).toBeDefined();
    expect(result.diagnostic.nearestMatch.line).toBe(1);
    expect(result.diagnostic.nearestMatch.similarity).toBeGreaterThan(0.5);
  });

  it("returns structured diagnostic for multiple matches", async () => {
    const testFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(testFile, "const x = 1;\nconst y = 2;\nconst x = 1;\nconst z = 3;");

    const result = executeStrReplace(testFile, "const x = 1;", "const x = 42;");

    expect(result.success).toBe(false);
    expect(result.error).toContain("匹配 2 处");
    expect(result.diagnostic).toBeDefined();
    expect(result.diagnostic.kind).toBe("multiple_matches");
    expect(result.diagnostic.matchCount).toBe(2);
    expect(result.diagnostic.positions).toHaveLength(2);
    expect(result.diagnostic.positions[0].line).toBe(1);
    expect(result.diagnostic.positions[1].line).toBe(3);
  });

  it("provides context for multiple match positions", async () => {
    const testFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(testFile, "// header\nconst x = 1;\n// middle\nconst x = 1;\n// footer");

    const result = executeStrReplace(testFile, "const x = 1;", "const x = 42;");

    expect(result.success).toBe(false);
    expect(result.diagnostic.positions[0].context).toContain("header");
    expect(result.diagnostic.positions[1].context).toContain("middle");
  });

  it("returns error for empty file_path", async () => {
    const result = executeStrReplace("", "test", "new");

    expect(result.success).toBe(false);
    expect(result.error).toContain("file_path 不能为空");
  });

  it("returns error for non-existent file", async () => {
    const result = executeStrReplace("/nonexistent/file.txt", "test", "new");

    expect(result.success).toBe(false);
    expect(result.error).toContain("文件不存在");
  });

  it("returns error for empty old_string", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(testFile, "content");

    const result = executeStrReplace(testFile, "", "new");

    expect(result.success).toBe(false);
    expect(result.error).toContain("old_string 不能为空");
  });

  it("does not modify file on failure", async () => {
    const testFile = path.join(tmpDir, "test.ts");
    const original = "const foo = 1;\nconst bar = 2;";
    fs.writeFileSync(testFile, original);

    executeStrReplace(testFile, "not found", "replacement");

    expect(fs.readFileSync(testFile, "utf8")).toBe(original);
  });
});

describe("str_replace multiline old_string", () => {
  it("handles multiline old_string", async () => {
    const testFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(testFile, "function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}");

    const result = executeStrReplace(
      testFile,
      "function foo() {\n  return 1;\n}",
      "function foo() {\n  return 42;\n}",
    );

    expect(result.success).toBe(true);
    expect(fs.readFileSync(testFile, "utf8")).toContain("return 42;");
  });

  it("provides diagnostic for multiline old_string not found", async () => {
    const testFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(testFile, "function foo() {\n  return 1;\n}");

    const result = executeStrReplace(
      testFile,
      "function foo() {\n  return 999;\n}",
      "function foo() {\n  return 42;\n}",
    );

    expect(result.success).toBe(false);
    expect(result.diagnostic.kind).toBe("not_found");
  });
});
