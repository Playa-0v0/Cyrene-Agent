/**
 * VerificationRunner - 验证执行核心
 *
 * 职责：
 * - 执行结构化命令
 * - 超时
 * - stdout/stderr 截断
 * - 退出码归一化
 * - 取消
 * - 权限审批
 * - 结果归一化
 *
 * 不推断项目结构，不修改验证计划。
 *
 * Code 模式和 Work 工具 run_verification 共用此执行核心。
 */

import spawn from "cross-spawn";
import * as path from "path";
import * as fs from "fs";
import { policyFor, type AgentFileAccessLevel } from "../permission-policy";

// ── 类型 ──────────────────────────────────────────────────

export type VerificationType = "typecheck" | "test" | "lint" | "build";
export type VerificationCommandTrust = "builtin" | "workspace_script" | "custom";

export interface VerificationStep {
  id: string;
  type: VerificationType;
  packageRoot: string;
  cwd: string;
  configPath?: string;
  trust: VerificationCommandTrust;
  executable: string;
  args: string[];
  source: "cyrene_config" | "package_script" | "tsconfig" | "vitest" | "jest" | "builtin_fallback";
}

export interface VerificationResult {
  stepId: string;
  type: VerificationType;
  passed: boolean;
  skipped: boolean;
  trust: VerificationCommandTrust;
  executable: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  errorCode?: string;
}

export type VerificationSummaryStatus =
  | "passed"
  | "failed"
  | "not_run"
  | "approval_required"
  | "plan_not_found";

export interface VerificationSummary {
  status: VerificationSummaryStatus;
  passed: boolean;
  steps: VerificationResult[];
  errorCode?:
    | "VERIFICATION_PLAN_NOT_FOUND"
    | "VERIFICATION_CONFIG_INVALID"
    | "VERIFICATION_APPROVAL_REQUIRED"
    | "VERIFICATION_APPROVAL_REJECTED"
    | "VERIFICATION_PERMISSION_DENIED"
    | "VERIFICATION_TIMEOUT"
    | "VERIFICATION_EXECUTION_FAILED";
}

export interface VerificationPermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

export type PermissionLevel = AgentFileAccessLevel;

// ── 工具函数 ──────────────────────────────────────────────

/** 解析 builtin 可执行文件为本地 tsc/vitest/jest 路径 */
function isWithinPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isLocalDependencyCli(cliPath: string, cwd: string): boolean {
  if (!path.isAbsolute(cliPath) || !fs.existsSync(cliPath)) return false;
  let resolvedCli: string;
  let cursor: string;
  try {
    resolvedCli = fs.realpathSync(cliPath);
    cursor = fs.realpathSync(cwd);
  } catch {
    return false;
  }

  while (true) {
    const packageJson = path.join(cursor, "package.json");
    const dependencyRoot = path.join(cursor, "node_modules");
    if (fs.existsSync(packageJson) && fs.existsSync(dependencyRoot)) {
      try {
        if (isWithinPath(resolvedCli, fs.realpathSync(dependencyRoot))) return true;
      } catch {
        // 继续检查更上层 package 边界。
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

export function resolveBuiltinExecutable(
  executable: string,
  cwd: string,
  configPath?: string,
): { executable: string; args: string[] } | null {
  // builtin:tsc -> node + typescript/bin/tsc
  // 必须解析到本地 node_modules/typescript/bin/tsc（绝对路径）
  if (executable === "builtin:tsc") {
    try {
      const tscCliPath = require.resolve("typescript/bin/tsc", { paths: [cwd] });
      // 验证文件存在且为绝对路径
      if (!isLocalDependencyCli(tscCliPath, cwd)) return null;
      return { executable: process.execPath, args: [tscCliPath] };
    } catch {
      return null;
    }
  }
  if (executable === "builtin:vitest") {
    try {
      // vitest 提供 vitest.mjs 作为入口
      const vitestCliPath = require.resolve("vitest/vitest.mjs", { paths: [cwd] });
      if (!isLocalDependencyCli(vitestCliPath, cwd)) return null;
      return { executable: process.execPath, args: [vitestCliPath, "run"] };
    } catch {
      // fallback: 尝试 vitest 包
      try {
        const vitestPkgPath = require.resolve("vitest/package.json", { paths: [cwd] });
        const vitestBinPath = path.join(path.dirname(vitestPkgPath), "vitest.mjs");
        if (!isLocalDependencyCli(vitestBinPath, cwd)) return null;
        return { executable: process.execPath, args: [vitestBinPath, "run"] };
      } catch {
        return null;
      }
    }
  }
  if (executable === "builtin:jest") {
    try {
      const jestCliPath = require.resolve("jest/bin/jest.js", { paths: [cwd] });
      if (!isLocalDependencyCli(jestCliPath, cwd)) return null;
      return { executable: process.execPath, args: [jestCliPath] };
    } catch {
      return null;
    }
  }
  // 不是 builtin 标记
  return { executable, args: [] };
}

function truncateOutput(s: string, maxLen = 4000): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `\n... (truncated, total ${s.length} chars)`;
}

function hashStderr(stderr: string): string {
  const crypto = require("crypto") as typeof import("crypto");
  return crypto.createHash("sha256").update(stderr.slice(0, 500)).digest("hex").slice(0, 8);
}

// ── VerificationRunner 主类 ──────────────────────────────────

export interface RunnerOptions {
  permissionLevel: PermissionLevel;
  /** 用于审批回调（custom 命令） */
  onApprovalRequest?: (step: VerificationStep) => Promise<boolean>;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 超时（默认 60 秒） */
  defaultTimeoutMs?: number;
}

export class VerificationRunner {
  /** 已执行过的失败指纹，避免无限循环 */
  private executedFingerprints: Set<string> = new Set();

  /** 决定是否允许执行某命令 */
  decidePermission(
    step: VerificationStep,
    permissionLevel: PermissionLevel,
  ): VerificationPermissionDecision {
    if (step.trust === "builtin") {
      return { allowed: true, requiresApproval: false };
    }
    if (step.trust === "custom") {
      // 显式自定义验证不是普通 workspace script；无论全局档位如何都要逐步确认。
      return { allowed: true, requiresApproval: true, reason: "custom 命令需要审批" };
    }

    if (step.trust === "workspace_script") {
      // 权限档位到 allow/ask/deny 的映射只由 permission.ts 维护。
      const policy = policyFor(permissionLevel, "shell");
      if (policy === "allow") return { allowed: true, requiresApproval: false };
      if (policy === "ask") {
        return { allowed: true, requiresApproval: true, reason: "workspace_script 需要审批" };
      }
      return { allowed: false, requiresApproval: false, reason: "当前权限档位不允许执行 workspace script" };
    }

    return { allowed: false, requiresApproval: false, reason: "未知验证命令信任级别" };
  }

  /** 执行单个 step */
  async runStep(step: VerificationStep, options: RunnerOptions): Promise<VerificationResult> {
    const decision = this.decidePermission(step, options.permissionLevel);
    if (!decision.allowed) {
      return {
        stepId: step.id,
        type: step.type,
        passed: false,
        skipped: true,
        trust: step.trust,
        executable: step.executable,
        args: step.args,
        cwd: step.cwd,
        exitCode: null,
        stdout: "",
        stderr: decision.reason ?? "permission denied",
        timedOut: false,
        durationMs: 0,
        errorCode: decision.requiresApproval
          ? "VERIFICATION_APPROVAL_REQUIRED"
          : "VERIFICATION_PERMISSION_DENIED",
      };
    }

    if (decision.requiresApproval && !options.onApprovalRequest) {
      return {
        stepId: step.id,
        type: step.type,
        passed: false,
        skipped: true,
        trust: step.trust,
        executable: step.executable,
        args: step.args,
        cwd: step.cwd,
        exitCode: null,
        stdout: "",
        stderr: decision.reason ?? "需要用户审批",
        timedOut: false,
        durationMs: 0,
        errorCode: "VERIFICATION_APPROVAL_REQUIRED",
      };
    }

    if (decision.requiresApproval && options.onApprovalRequest) {
      const approved = await options.onApprovalRequest(step);
      if (!approved) {
        return {
          stepId: step.id,
          type: step.type,
          passed: false,
          skipped: true,
          trust: step.trust,
          executable: step.executable,
          args: step.args,
          cwd: step.cwd,
          exitCode: null,
          stdout: "",
          stderr: "用户拒绝审批",
          timedOut: false,
          durationMs: 0,
          errorCode: "VERIFICATION_APPROVAL_REJECTED",
        };
      }
    }

    // 解析 builtin 执行入口
    const resolved = resolveBuiltinExecutable(step.executable, step.cwd, step.configPath);
    if (step.executable.startsWith("builtin:") && !resolved) {
      return {
        stepId: step.id,
        type: step.type,
        passed: false,
        skipped: true,
        trust: step.trust,
        executable: step.executable,
        args: step.args,
        cwd: step.cwd,
        exitCode: null,
        stdout: "",
        stderr: `无法解析 builtin 执行入口: ${step.executable}`,
        timedOut: false,
        durationMs: 0,
        errorCode: "VERIFICATION_EXECUTION_FAILED",
      };
    }

    const exec = resolved ?? { executable: step.executable, args: step.args };
    // builtin resolver 只提供 “node + 本地 CLI 入口”等前缀；
    // VerificationStep 自身参数必须原样追加，不能在解析时丢失。
    const allArgs = [...exec.args, ...step.args];

    return this.executeCommand(step, exec.executable, allArgs, options);
  }

  /** 执行一组 step，返回 summary */
  async runPlan(
    steps: VerificationStep[],
    options: RunnerOptions,
  ): Promise<VerificationSummary> {
    if (steps.length === 0) {
      return { status: "not_run", passed: false, steps: [] };
    }

    const results: VerificationResult[] = [];
    for (const step of steps) {
      // 检查失败指纹
      const fingerprint = this.fingerprint(step);
      if (this.executedFingerprints.has(fingerprint)) {
        results.push({
          stepId: step.id,
          type: step.type,
          passed: false,
          skipped: true,
          trust: step.trust,
          executable: step.executable,
          args: step.args,
          cwd: step.cwd,
          exitCode: null,
          stdout: "",
          stderr: "同一失败指纹已执行过，不重复运行",
          timedOut: false,
          durationMs: 0,
          errorCode: "VERIFICATION_EXECUTION_FAILED",
        });
        continue;
      }

      const result = await this.runStep(step, options);
      results.push(result);
      this.executedFingerprints.add(fingerprint);
    }

    const allPassed = results.every(r => r.passed);
    const anyApprovalRequired = results.some(r => r.errorCode === "VERIFICATION_APPROVAL_REQUIRED");

    let status: VerificationSummaryStatus;
    let errorCode: VerificationSummary["errorCode"];
    if (anyApprovalRequired) {
      status = "approval_required";
      errorCode = "VERIFICATION_APPROVAL_REQUIRED";
    } else if (allPassed) {
      status = "passed";
    } else {
      status = "failed";
    }

    return { status, passed: allPassed, steps: results, errorCode };
  }

  /** 重新执行（用于测试，不复用指纹） */
  resetFingerprints(): void {
    this.executedFingerprints.clear();
  }

  // ── 私有方法 ────────────────────────────────────────────

  private fingerprint(step: VerificationStep): string {
    // 失败指纹：type + cwd + executable + args + 早期错误特征
    return [
      step.type,
      step.cwd,
      step.executable,
      step.args.join("\x00"),
    ].join("|");
  }

  private executeCommand(
    step: VerificationStep,
    executable: string,
    args: string[],
    options: RunnerOptions,
  ): Promise<VerificationResult> {
    const startMs = Date.now();
    const timeoutMs = options.defaultTimeoutMs ?? 60_000;
    return new Promise<VerificationResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let child: ReturnType<typeof spawn> | null = null;

      try {
        // 在 Windows 上传递 ELECTRON_RUN_AS_NODE=1 让 electron 当作纯 Node 运行
        const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

        child = spawn(executable, args, {
          cwd: step.cwd,
          env,
          shell: false, // 不经过 shell，避免拼接
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        resolve({
          stepId: step.id,
          type: step.type,
          passed: false,
          skipped: false,
          trust: step.trust,
          executable: step.executable,
          args: step.args,
          cwd: step.cwd,
          exitCode: null,
          stdout: "",
          stderr: (err as Error).message,
          timedOut: false,
          durationMs: Date.now() - startMs,
          errorCode: "VERIFICATION_EXECUTION_FAILED",
        });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        if (child && !child.killed) {
          child.kill("SIGTERM");
        }
      }, timeoutMs);

      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          if (child && !child.killed) {
            child.kill("SIGTERM");
          }
        }, { once: true });
      }

      child.stdout?.on("data", (d) => {
        stdout += d.toString();
        if (stdout.length > 8000) {
          stdout = truncateOutput(stdout);
        }
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
        if (stderr.length > 8000) {
          stderr = truncateOutput(stderr);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          stepId: step.id,
          type: step.type,
          passed: false,
          skipped: false,
          trust: step.trust,
          executable: step.executable,
          args: step.args,
          cwd: step.cwd,
          exitCode: null,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr) + `\n[spawn error] ${err.message}`,
          timedOut: false,
          durationMs: Date.now() - startMs,
          errorCode: "VERIFICATION_EXECUTION_FAILED",
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startMs;
        const result: VerificationResult = {
          stepId: step.id,
          type: step.type,
          passed: code === 0,
          skipped: false,
          trust: step.trust,
          executable: step.executable,
          args: step.args,
          cwd: step.cwd,
          exitCode: code,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          timedOut,
          durationMs,
        };
        if (timedOut) {
          result.errorCode = "VERIFICATION_TIMEOUT";
        } else if (code !== 0) {
          result.errorCode = "VERIFICATION_EXECUTION_FAILED";
        }
        resolve(result);
      });
    });
  }
}
