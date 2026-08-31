import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("electron", () => ({
  app: { getPath: () => process.env.TEMP ?? process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("../index", () => ({
  sendToLive2DWindow: vi.fn(),
}));

import { toolRegistry } from "./tool-registry";
import { setCurrentLevel } from "../permission";
import { VerificationRunner, type VerificationResult } from "./verification-runner";
import "./built-in-tools";

const runVerification = toolRegistry.getById("run_verification")!.execute;

function result(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    stepId: "run_verification_typecheck",
    type: "typecheck",
    passed: true,
    skipped: false,
    trust: "workspace_script",
    executable: process.execPath,
    args: [],
    cwd: process.cwd(),
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    timedOut: false,
    durationMs: 12,
    ...overrides,
  };
}

describe("Work run_verification 收口", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(process.cwd(), ".tmp-work-verification-"));
    fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({
      compilerOptions: { noEmit: true },
      include: ["sample.ts"],
    }));
    fs.writeFileSync(path.join(cwd, "sample.ts"), "export const value = 1;\n");
    setCurrentLevel("full");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCurrentLevel("read-only");
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("成功结果保持旧 JSON 协议，并调用共享 VerificationRunner", async () => {
    const runStep = vi.spyOn(VerificationRunner.prototype, "runStep")
      .mockResolvedValue(result({ cwd }));

    const parsed = JSON.parse(await runVerification({ verificationType: "typecheck", cwd }));

    expect(runStep).toHaveBeenCalledOnce();
    expect(runStep.mock.calls[0][0].executable).toBe("builtin:tsc");
    expect(parsed).toMatchObject({
      success: true,
      verificationType: "typecheck",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      spawnError: null,
      timedOut: false,
      passed: true,
    });
  });

  it("test 使用 builtin:vitest 本地入口，不调用 npx", async () => {
    const runStep = vi.spyOn(VerificationRunner.prototype, "runStep")
      .mockResolvedValue(result({ cwd, type: "test", stepId: "run_verification_test" }));

    await runVerification({ verificationType: "test", cwd });

    expect(runStep).toHaveBeenCalledOnce();
    expect(runStep.mock.calls[0][0]).toMatchObject({
      executable: "builtin:vitest",
      args: ["--reporter=verbose"],
    });
  });

  it("build 使用工作区检测到的包管理器执行标准 build 脚本", async () => {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      scripts: { build: "node -e \"console.log('built')\"" },
    }));
    fs.writeFileSync(path.join(cwd, "package-lock.json"), "{}\n");
    const runStep = vi.spyOn(VerificationRunner.prototype, "runStep")
      .mockResolvedValue(result({ cwd, type: "build", stepId: "run_verification_build" }));

    const parsed = JSON.parse(await runVerification({ verificationType: "build", cwd }));

    expect(runStep).toHaveBeenCalledOnce();
    expect(runStep.mock.calls[0][0]).toMatchObject({
      executable: "npm",
      args: ["run", "build"],
      cwd,
      source: "package_script",
    });
    expect(parsed).toMatchObject({
      verificationType: "build",
      passed: true,
    });
    expect(parsed.command).toContain("npm run build");
  });

  it("build 尊重工作区声明的 pnpm 包管理器", async () => {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.0.0",
      scripts: { build: "node -e \"console.log('built')\"" },
    }));
    fs.writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const runStep = vi.spyOn(VerificationRunner.prototype, "runStep")
      .mockResolvedValue(result({ cwd, type: "build", stepId: "run_verification_build" }));

    await runVerification({ verificationType: "build", cwd });

    expect(runStep).toHaveBeenCalledOnce();
    expect(runStep.mock.calls[0][0]).toMatchObject({
      executable: "pnpm",
      args: ["run", "build"],
    });
  });

  it("build 在工作区未定义 scripts.build 时返回结构化错误", async () => {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    fs.writeFileSync(path.join(cwd, "package-lock.json"), "{}\n");
    const runStep = vi.spyOn(VerificationRunner.prototype, "runStep");

    const parsed = JSON.parse(await runVerification({ verificationType: "build", cwd }));

    expect(runStep).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({
      success: false,
      errorCode: "PACKAGE_SCRIPT_NOT_FOUND",
      passed: false,
      actualCwd: cwd,
    });
  });

  it("build 通过共享 Runner 实际执行工作区脚本", async () => {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      scripts: { build: "node -e \"process.stdout.write('workspace-build-ok')\"" },
    }));
    fs.writeFileSync(path.join(cwd, "package-lock.json"), "{}\n");

    const parsed = JSON.parse(await runVerification({ verificationType: "build", cwd }));

    expect(parsed).toMatchObject({
      success: true,
      verificationType: "build",
      exitCode: 0,
      passed: true,
    });
    expect(parsed.stdout).toContain("workspace-build-ok");
  });

  it("命令正常启动但退出码非零时 success 仍兼容旧协议，passed=false", async () => {
    vi.spyOn(VerificationRunner.prototype, "runStep").mockResolvedValue(result({
      cwd,
      passed: false,
      exitCode: 2,
      stdout: "",
      stderr: "type error",
      errorCode: "VERIFICATION_EXECUTION_FAILED",
    }));

    const parsed = JSON.parse(await runVerification({ verificationType: "typecheck", cwd }));

    expect(parsed.success).toBe(true);
    expect(parsed.passed).toBe(false);
    expect(parsed.exitCode).toBe(2);
    expect(parsed.stderr).toBe("type error");
  });

  it("共享 Runner timeout 透传 timedOut/errorCode/retryable", async () => {
    vi.spyOn(VerificationRunner.prototype, "runStep").mockResolvedValue(result({
      cwd,
      passed: false,
      exitCode: null,
      timedOut: true,
      errorCode: "VERIFICATION_TIMEOUT",
    }));

    const parsed = JSON.parse(await runVerification({ verificationType: "typecheck", cwd }));

    expect(parsed.success).toBe(false);
    expect(parsed.timedOut).toBe(true);
    expect(parsed.errorCode).toBe("VERIFICATION_TIMEOUT");
    expect(parsed.retryable).toBe(true);
  });

  it("cwd 下配置不存在时保持结构化失败，且不调用 Runner", async () => {
    fs.rmSync(path.join(cwd, "tsconfig.json"));
    const runStep = vi.spyOn(VerificationRunner.prototype, "runStep");

    const parsed = JSON.parse(await runVerification({ verificationType: "typecheck", cwd }));

    expect(runStep).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({
      success: false,
      errorCode: "VERIFICATION_CONFIG_NOT_FOUND",
      actualCwd: cwd,
      passed: false,
      timedOut: false,
    });
  });
});
