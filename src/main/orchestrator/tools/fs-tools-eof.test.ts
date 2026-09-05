import { beforeAll, describe, expect, it } from "vitest";
import { toolRegistry } from "./registry/tool-registry";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// read_file 假 EOF 回归测试：旧实现 256KB 砍头后 totalLines 在残件上统计，
// 模型翻页到低报行数误判 EOF，后半文件静默丢失（见 docs/internal-issue/2026-09-06 文档）。
describe("read_file 假 EOF 修复", () => {
  let tmpDir: string;

  beforeAll(async () => {
    await import("./fs-tools");
  });

  it("reports real totalLines for files between 256KB and 10MB and paginates to the true end", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "readfile-eof-"));
    // 约 900KB 的文件：旧 256KB 上限会砍掉后 2/3，totalLines 严重低报
    const line = "x".repeat(90);
    const lines = Array.from({ length: 10_000 }, (_, i) => `line-${i} ${line}`);
    const file = path.join(tmpDir, "big.txt");
    fs.writeFileSync(file, lines.join("\n"), "utf8");

    const tool = toolRegistry.getById("read_file");
    expect(tool).toBeDefined();

    // 第一页：totalLines 必须是真实行数（不是残件上的低报值）
    const first = JSON.parse(await tool!.execute({ path: file, startLine: 1, maxLines: 10 })) as {
      totalLines: number; startLine: number; endLine: number; truncated: boolean;
    };
    expect(first.totalLines).toBe(10_000);
    expect(first.truncated).toBe(false);

    // 翻到真实末尾：内容可见，不再出现"假 EOF 后半丢失"
    const last = JSON.parse(await tool!.execute({ path: file, startLine: 9_995, maxLines: 10 })) as {
      totalLines: number; startLine: number; endLine: number; content: string;
    };
    expect(last.endLine).toBe(10_000);
    expect(last.content).toContain("line-9999");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects files above 10MB honestly (no silent truncation, guides to search_text)", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "readfile-toolarge-"));
    // 11MB 文本：超过 10MB 内存保护上限
    const chunk = "y".repeat(100) + "\n";
    const file = path.join(tmpDir, "huge.txt");
    const fh = fs.openSync(file, "w");
    for (let i = 0; i < 112_640; i++) fs.writeSync(fh, chunk); // ~11.04MB
    fs.closeSync(fh);

    const tool = toolRegistry.getById("read_file");
    const result = JSON.parse(await tool!.execute({ path: file })) as {
      success: boolean; errorCode: string; error: string;
    };
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("FILE_TOO_LARGE");
    // 如实契约：明确说不支持 + 引导 search_text 直接获取上下文（不承诺不存在的"定位后按行读"链路）
    expect(result.error).toContain("暂不支持");
    expect(result.error).toContain("search_text");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});