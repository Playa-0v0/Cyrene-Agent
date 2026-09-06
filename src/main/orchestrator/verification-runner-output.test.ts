import { describe, expect, it } from "vitest";
import { VerificationRunner, DEFAULT_TIMEOUT_MS_BY_TYPE, type VerificationStep } from "./verification-runner";

// C3 验收测试：头尾窗口视图截断 + 捕获不再流中砍尾 + 超时分档
// 背景：旧实现 slice(0,4000) 砍尾保头 + 流中 8000 字符截断，汇总行/失败详情
// 恰在输出末尾被永久裁掉；60s 一刀切超时把 ~124s 的全量测试杀在半路。
function makeStep(overrides: Partial<VerificationStep> = {}): VerificationStep {
  return {
    id: "test-step",
    type: "test",
    packageRoot: process.cwd(),
    cwd: process.cwd(),
    trust: "builtin",
    executable: process.execPath,
    args: [],
    source: "cyrene_config",
    ...overrides,
  };
}

describe("verification-runner 输出与超时", () => {
  it("超时分档：typecheck/lint 2min、build 5min、test 10min", () => {
    expect(DEFAULT_TIMEOUT_MS_BY_TYPE.typecheck).toBe(2 * 60_000);
    expect(DEFAULT_TIMEOUT_MS_BY_TYPE.lint).toBe(2 * 60_000);
    expect(DEFAULT_TIMEOUT_MS_BY_TYPE.build).toBe(5 * 60_000);
    expect(DEFAULT_TIMEOUT_MS_BY_TYPE.test).toBe(10 * 60_000);
  });

  it("长输出保留头尾窗口：末尾汇总标记不被流中截断丢掉", async () => {
    // 30000+ 字符输出：旧实现流中 8000 字符处砍尾，TAIL_SUMMARY 永久丢失
    const runner = new VerificationRunner();
    const result = await runner.runStep(makeStep({
      args: ["-e", "process.stdout.write('HEAD_MARKER');process.stdout.write('m'.repeat(30000));process.stdout.write('\\nTAIL_SUMMARY_OK')"],
    }), { permissionLevel: "full" });

    expect(result.passed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("HEAD_MARKER");
    expect(result.stdout).toContain("TAIL_SUMMARY_OK");
    expect(result.stdout).toContain("... (truncated");
  });

  it("显式 defaultTimeoutMs 覆盖档位默认，超时杀进程并标记 VERIFICATION_TIMEOUT", async () => {
    const runner = new VerificationRunner();
    const result = await runner.runStep(makeStep({
      args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
    }), { permissionLevel: "full", defaultTimeoutMs: 1_500 });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("VERIFICATION_TIMEOUT");
    expect(result.passed).toBe(false);
  }, 15_000);
});