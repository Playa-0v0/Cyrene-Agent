import { beforeAll, describe, expect, it } from "vitest";
import { toolRegistry } from "../registry/tool-registry";

// run_shell 捕获层验收测试：每流 2MB 上限 + captureTruncated 语义 + 字段顺序（stdout 置尾）
// 背景：旧实现 16KB 砍头导致 npm test 汇总行永久丢失（见 docs/internal-issue/2026-09-06 文档）。
describe.runIf(process.platform === "win32")("run_shell capture limit", () => {
  beforeAll(async () => {
    await import("../built-in-tools");
  });

  async function runShell(command: string) {
    const tool = toolRegistry.getById("run_shell");
    if (!tool) throw new Error("run_shell was not registered");
    const raw = await tool.execute(
      { command },
      { permissionMode: "allow_all" } as never,
    );
    return {
      json: raw,
      parsed: JSON.parse(raw) as {
        exitCode: number | null;
        stdout: string;
        stderr: string;
        captureTruncated: boolean;
        [key: string]: unknown;
      },
    };
  }

  it("keeps full output below 2MB per stream (old 16KB cap would have dropped the tail)", async () => {
    // 40KB 输出：超过旧 16KB 上限、远低于新 2MB——必须完整保留，尾部标记可见
    const { parsed } = await runShell(
      'node -e "process.stdout.write(\'x\'.repeat(40960)); process.stdout.write(\'TAIL_SUMMARY_OK\')"',
    );
    expect(parsed.exitCode).toBe(0);
    expect(parsed.captureTruncated).toBe(false);
    expect(parsed.stdout.endsWith("TAIL_SUMMARY_OK")).toBe(true);
    expect(parsed.stdout.length).toBeGreaterThanOrEqual(40960);
  });

  it("marks captureTruncated and stops accumulating beyond 2MB in a stream", async () => {
    // 3MB stdout 超过 2MB 捕获上限：标记 captureTruncated，且不再继续累积（不会到 3MB）
    const { parsed } = await runShell(
      'node -e "process.stdout.write(\'x\'.repeat(3*1024*1024))"',
    );
    expect(parsed.exitCode).toBe(0);
    expect(parsed.captureTruncated).toBe(true);
    expect(parsed.stdout.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 8192);
    expect(parsed.stdout.length).toBeGreaterThan(1024 * 1024);
  });

  it("enforces the cap per stream: stdout flood must not evict a stderr ERROR", async () => {
    // stdout 洪流 3MB + stderr 末尾一条错误：per-stream 计量下 stderr 的 ERROR 必须保留
    const { parsed } = await runShell(
      'node -e "process.stdout.write(\'x\'.repeat(3*1024*1024)); process.stderr.write(\'REAL_ERROR_LINE_12345\')"',
    );
    expect(parsed.captureTruncated).toBe(true);
    expect(parsed.stderr).toContain("REAL_ERROR_LINE_12345");
  });

  it("serializes stdout as the last large field so dispatcher tail window covers it", async () => {
    // 字段顺序契约：stdout 排在 JSON 末尾，stderr 在 stdout 之前——
    // 保证下游截断的尾窗覆盖 stdout 尾部（汇总行所在处）
    const { json, parsed } = await runShell('node -e "console.log(\'order-check\')"');
    const keys = Object.keys(parsed);
    expect(keys[keys.length - 1]).toBe("stdout");
    expect(keys.indexOf("stderr")).toBeLessThan(keys.indexOf("stdout"));
    // 兜底：原始 JSON 字符串里 stderr 也排在 stdout 字段之前
    expect(json.indexOf('"stderr"')).toBeLessThan(json.indexOf('"stdout"'));
  });
});