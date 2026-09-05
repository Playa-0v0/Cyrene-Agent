import { beforeAll, describe, expect, it } from "vitest";
import { toolRegistry } from "../registry/tool-registry";
import { resolveTimeoutPolicy } from "./run-shell-tool";

// run_shell timeout_ms 验收测试（C4）：
// - 纯函数层：钳制区间 [1s, 30min] + 显式 deadline 禁用 idle 检测
// - 真实进程层：超时杀进程 + 引导文案；静默命令在显式 deadline 下正常完成
// 背景：idle 2min 是"无输出=卡死"启发式，会误杀 rm -rf 大目录/linker 类无输出长任务
// （见 docs/internal-issue/2026-09-06 文档方案 3）。
describe("resolveTimeoutPolicy（纯函数）", () => {
  it("未传/空值/非数字 → 默认策略（idle 2min + total 30min）", () => {
    for (const raw of [undefined, null, "", "abc", true, false, {}, Number.NaN]) {
      expect(resolveTimeoutPolicy(raw), `raw=${String(raw)}`).toEqual({
        idleMs: 2 * 60_000,
        totalMs: 30 * 60_000,
        explicitDeadline: false,
      });
    }
  });

  it("数字（含字符串数字）→ 显式 deadline，idle 检测禁用", () => {
    for (const raw of [5000, "5000", 5000.4]) {
      expect(resolveTimeoutPolicy(raw), `raw=${String(raw)}`).toEqual({
        idleMs: undefined,
        totalMs: 5000,
        explicitDeadline: true,
      });
    }
  });

  it("钳制：0/负数/过小 → 1000；超大 → 1800000", () => {
    for (const raw of [0, -50, 100, 999]) {
      expect(resolveTimeoutPolicy(raw).totalMs, `raw=${String(raw)}`).toBe(1000);
    }
    for (const raw of [99_999_999, 10 * 60_000 * 60]) {
      expect(resolveTimeoutPolicy(raw).totalMs, `raw=${String(raw)}`).toBe(1_800_000);
    }
  });

  it("显式 deadline 一律禁用 idle 检测（无输出长任务不被误杀的机制保障）", () => {
    // 验收场景：timeout_ms=300000 + 命令 150 秒无任何输出 → 不被 idle 杀
    // （真实 150s 场景留给实机验证，单测锁死 idleMs=undefined 这一机制本身）
    const policy = resolveTimeoutPolicy(300_000);
    expect(policy.idleMs).toBeUndefined();
    expect(policy.totalMs).toBe(300_000);
    expect(policy.explicitDeadline).toBe(true);
  });
});

describe.runIf(process.platform === "win32")("run_shell timeout_ms（真实进程）", () => {
  beforeAll(async () => {
    await import("../built-in-tools");
  });

  async function runShell(command: string, timeout_ms?: number) {
    const tool = toolRegistry.getById("run_shell");
    if (!tool) throw new Error("run_shell was not registered");
    const raw = await tool.execute(
      { command, ...(timeout_ms !== undefined ? { timeout_ms } : {}) },
      { permissionMode: "allow_all" } as never,
    );
    return JSON.parse(raw) as {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      [key: string]: unknown;
    };
  }

  it(
    "timeout_ms=3000：10 秒静默命令 3 秒被杀，返回超时原因与增大 timeout_ms 引导",
    async () => {
      const start = Date.now();
      const parsed = await runShell('node -e "setTimeout(()=>{},10000)"', 3000);
      const elapsed = Date.now() - start;
      expect(parsed.timedOut).toBe(true);
      expect(parsed.exitCode).toBeNull();
      // 原因如实回显钳制后的 deadline 值
      expect(parsed.stderr).toContain("timeout_ms=3000 毫秒执行上限");
      // 引导模型自纠：可增大 timeout_ms 重试
      expect(parsed.stderr).toContain("增大 timeout_ms");
      // 3s deadline 生效（不早于 2.9s），kill 宽限 2s 内收尸（不晚于 8s）
      expect(elapsed).toBeGreaterThanOrEqual(2900);
      expect(elapsed).toBeLessThan(8000);
    },
    20_000,
  );

  it(
    "timeout_ms=100 钳制到 1000：2 秒静默命令 1 秒被杀，回显钳制后的值",
    async () => {
      const parsed = await runShell('node -e "setTimeout(()=>{},2000)"', 100);
      expect(parsed.timedOut).toBe(true);
      expect(parsed.stderr).toContain("timeout_ms=1000 毫秒执行上限");
    },
    15_000,
  );

  it(
    "timeout_ms=15000：4 秒完全静默的命令正常完成（显式 deadline 下无输出不判卡死）",
    async () => {
      const parsed = await runShell('node -e "setTimeout(()=>process.exit(0),4000)"', 15000);
      expect(parsed.timedOut).toBe(false);
      expect(parsed.exitCode).toBe(0);
    },
    20_000,
  );
});