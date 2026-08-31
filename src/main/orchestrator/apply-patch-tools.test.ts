import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parsePatch, applyPatchHunks } from "./apply-patch-tools";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(tmpDir, rel), "utf8");
}

// ── Parser 测试 ──────────────────────────────────────────

describe("parsePatch", () => {
  it("parses a single Update File with one chunk", () => {
    const patch = `*** Begin Patch
*** Update File: src/foo.ts
@@
 const a = 1;
-const b = 2;
+const b = 3;
*** End Patch`;
    const result = parsePatch(patch);
    expect(result.errors).toHaveLength(0);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0].type).toBe("update");
    expect(result.hunks[0].path).toBe("src/foo.ts");
    const hunk = result.hunks[0] as Extract<(typeof result.hunks)[number], { type: "update" }>;
    expect(hunk.chunks).toHaveLength(1);
    const chunk = hunk.chunks[0];
    // context + removal → preImage, context + addition → postImage
    expect(chunk.lines.filter((l) => l.type === "context").map((l) => l.content)).toEqual(["const a = 1;"]);
    expect(chunk.lines.filter((l) => l.type === "removal").map((l) => l.content)).toEqual(["const b = 2;"]);
    expect(chunk.lines.filter((l) => l.type === "addition").map((l) => l.content)).toEqual(["const b = 3;"]);
  });

  it("parses Add File", () => {
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export const bar = true;
+export const baz = false;
*** End Patch`;
    const result = parsePatch(patch);
    expect(result.errors).toHaveLength(0);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0].type).toBe("add");
    const hunk = result.hunks[0] as Extract<(typeof result.hunks)[number], { type: "add" }>;
    expect(hunk.content).toBe("export const bar = true;\nexport const baz = false;");
  });

  it("parses Delete File", () => {
    const patch = `*** Begin Patch
*** Delete File: src/old.ts
*** End Patch`;
    const result = parsePatch(patch);
    expect(result.errors).toHaveLength(0);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0].type).toBe("delete");
  });

  it("parses Move File via *** Move to:", () => {
    const patch = `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
 const x = 1;
*** End Patch`;
    const result = parsePatch(patch);
    expect(result.errors).toHaveLength(0);
    expect(result.hunks).toHaveLength(1);
    const hunk = result.hunks[0] as Extract<(typeof result.hunks)[number], { type: "update" }>;
    expect(hunk.movePath).toBe("src/new.ts");
  });

  it("parses multiple hunks in one patch", () => {
    const patch = `*** Begin Patch
*** Update File: a.ts
@@
-const x = 1;
+const x = 2;
*** Add File: b.ts
+hello
*** Delete File: c.ts
*** End Patch`;
    const result = parsePatch(patch);
    expect(result.errors).toHaveLength(0);
    expect(result.hunks).toHaveLength(3);
    expect(result.hunks[0].type).toBe("update");
    expect(result.hunks[1].type).toBe("add");
    expect(result.hunks[2].type).toBe("delete");
  });

  it("errors without *** Begin Patch", () => {
    const result = parsePatch("just some text");
    expect(result.hunks).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it("parses multiple chunks in one Update File", () => {
    const patch = `*** Begin Patch
*** Update File: src/foo.ts
@@
 const a = 1;
-old = 2;
+old = 3;
@@
 const b = 4;
-other = 5;
+other = 6;
*** End Patch`;
    const result = parsePatch(patch);
    expect(result.errors).toHaveLength(0);
    const hunk = result.hunks[0] as Extract<(typeof result.hunks)[number], { type: "update" }>;
    expect(hunk.chunks).toHaveLength(2);
  });
});

// ── Executor 测试 ────────────────────────────────────────

describe("applyPatchHunks", () => {
  it("updates a file with context matching", () => {
    writeFile("src/foo.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const { hunks } = parsePatch(`*** Begin Patch
*** Update File: src/foo.ts
@@
 const a = 1;
-const b = 2;
+const b = 99;
 const c = 3;
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(true);
    expect(readFile("src/foo.ts")).toBe("const a = 1;\nconst b = 99;\nconst c = 3;\n");
  });

  it("adds a new file", () => {
    const { hunks } = parsePatch(`*** Begin Patch
*** Add File: src/new.ts
+export const bar = true;
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(true);
    expect(readFile("src/new.ts")).toBe("export const bar = true;");
  });

  it("deletes a file", () => {
    writeFile("src/old.ts", "content");
    const { hunks } = parsePatch(`*** Begin Patch
*** Delete File: src/old.ts
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "src/old.ts"))).toBe(false);
  });

  it("fails if context does not match", () => {
    writeFile("src/foo.ts", "const a = 1;\nconst b = 2;\n");
    const { hunks } = parsePatch(`*** Begin Patch
*** Update File: src/foo.ts
@@
 const a = 1;
-const WRONG = 2;
+const b = 99;
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // 文件未被修改
    expect(readFile("src/foo.ts")).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("transactional: fails all if any hunk fails", () => {
    writeFile("src/a.ts", "line1\nline2\n");
    // b.ts 不存在 → 预验证失败
    const { hunks } = parsePatch(`*** Begin Patch
*** Update File: src/a.ts
@@
-line1
+line1modified
*** Update File: src/b.ts
@@
-something
+other
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(false);
    // a.ts 不应被修改
    expect(readFile("src/a.ts")).toBe("line1\nline2\n");
  });

  it("preserves CRLF line endings", () => {
    writeFile("src/foo.ts", "const a = 1;\r\nconst b = 2;\r\n");
    const { hunks } = parsePatch(`*** Begin Patch
*** Update File: src/foo.ts
@@
 const a = 1;
-const b = 2;
+const b = 99;
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(true);
    const content = readFile("src/foo.ts");
    expect(content).toBe("const a = 1;\r\nconst b = 99;\r\n");
  });

  it("parses and applies a CRLF-encoded patch text (stray \\r stripped)", () => {
    writeFile("src/foo.ts", "const a = 1;\r\nconst b = 2;\r\n");
    // patch 文本每行以 \r\n 结尾：解析时必须剥掉 \r，否则行内容带 \r 匹配失败
    const { hunks } = parsePatch(
      "*** Begin Patch\r\n" +
      "*** Update File: src/foo.ts\r\n" +
      "@@\r\n" +
      " const a = 1;\r\n" +
      "-const b = 2;\r\n" +
      "+const b = 99;\r\n" +
      "*** End Patch\r\n",
    );
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(true);
    expect(readFile("src/foo.ts")).toBe("const a = 1;\r\nconst b = 99;\r\n");
  });

  it("updates a mixed-EOL file and writes back the dominant EOL", () => {
    // 混合 EOL：前两行 CRLF、第三行孤立 LF
    writeFile("src/mixed.ts", "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\n");
    const { hunks } = parsePatch(`*** Begin Patch
*** Update File: src/mixed.ts
@@
 const b = 2;
-const c = 3;
+const c = 33;
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(true);
    expect(readFile("src/mixed.ts")).toBe("const a = 1;\r\nconst b = 2;\r\nconst c = 33;\r\n");
  });

  it("rejects path traversal outside workspace", () => {
    const { hunks } = parsePatch(`*** Begin Patch
*** Add File: ../../outside.ts
+evil
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("路径逃逸");
  });

  it("handles pure addition chunk (no removals)", () => {
    writeFile("src/foo.ts", "const a = 1;\nconst b = 2;\n");
    const { hunks } = parsePatch(`*** Begin Patch
*** Update File: src/foo.ts
@@
 const a = 1;
+const inserted = 0;
 const b = 2;
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(true);
    expect(readFile("src/foo.ts")).toBe("const a = 1;\nconst inserted = 0;\nconst b = 2;\n");
  });

  it("moves file with *** Move to:", () => {
    writeFile("src/old.ts", "const x = 1;\n");
    const { hunks } = parsePatch(`*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
 const x = 1;
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "src/old.ts"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "src/new.ts"))).toBe(true);
  });

  it("handles multiple chunks in same file", () => {
    writeFile("src/foo.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n");
    const { hunks } = parsePatch(`*** Begin Patch
*** Update File: src/foo.ts
@@
 const a = 1;
-const b = 2;
+const b = 20;
@@
 const c = 3;
-const d = 4;
+const d = 40;
*** End Patch`);
    const result = applyPatchHunks(hunks, tmpDir);
    expect(result.success).toBe(true);
    expect(readFile("src/foo.ts")).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 40;\n");
  });
});
