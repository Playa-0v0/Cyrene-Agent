// ── 工具 2：run_shell ─────────────────────────────────────
// 在用户机器上跑一行命令，给 agent 装 MCP 时跑 git/npm/pip 等用
// 注意：不开 shell（spawn shell:false），命令必须是真正的可执行文件，避免 shell 注入
//
// 原样迁自 built-in-tools.ts（纯搬移，逻辑未改——killTree/双计时器/kill 宽限期/
// windowsVerbatimArguments/GBK 解码等平台细节一律保持原状）。注册方式调整：
// 本模块导出 runShellTool 常量，由 built-in-tools.ts facade 在原注册位置统一
// toolRegistry.register，显式保证 registry 插入顺序（= 工具目录 prompt 生成顺序，
// 门禁见 built-in-tools.snapshot.test.ts）。

import { spawn } from "child_process";
import type { ToolDefinition } from "../registry/tool-registry";
import { wrapWithSandbox, type SandboxWrapOutcome } from "../../sandbox/sandbox-exec";
import { getCurrentLevel } from "../../../permission";
import { classifyShellEffect, isCatastrophicCommand, type ShellEffect } from "../../shell-execution-policy";
import { logger, LogTag } from "../../../logger";
import {
  buildDirectShellInvocation,
  resolveShellExecutable,
  type ResolvedShellExecutable,
  type ShellKind,
} from "../../shell-runtime";

const LOG_PREFIX = "[BuiltinTools]";

// ── 工具 2：run_shell ─────────────────────────────────────
// 在用户机器上跑一行命令，给 agent 装 MCP 时跑 git/npm/pip 等用
// 注意：不开 shell（spawn shell:false），命令必须是真正的可执行文件，避免 shell 注入

// 双计时器：不看命令跑了多久，看它多久没动静。
// - idle：连续 2 分钟无任何 stdout/stderr → 判定卡死（serve/watch 类静默进程、网络死锁）。
//   npm install / git push / 打包这类"长但在动"的命令会持续输出，不会误杀。
// - total：30 分钟总上限，无论如何强制结束（兜底）。
const SHELL_IDLE_TIMEOUT_MS = 2 * 60_000;
const SHELL_TOTAL_TIMEOUT_MS = 30 * 60_000;
// killTree 后等 close 的宽限期。taskkill /T 在进程链断开时会漏杀孙进程，
// 孙进程持有的 stdio 管道不关 → close 永不触发 → Promise 永不 resolve（655 分钟挂死的根因）。
// 宽限期一到无条件强制收尸，带上已收集的部分输出。
const SHELL_KILL_GRACE_MS = 2_000;
const SHELL_MAX_OUTPUT = 16 * 1024;  // 单次最多 16KB stdout/stderr

// ── Shell 输出解码 ─────────────────────────────────────
// 中文 Windows 的 cmd.exe 按系统 OEM 码页（GBK/CP936）输出（dir/echo/del 等内建命令），
// 直接 chunk.toString("utf8") 中文全是 U+FFFD 乱码。策略：Buffer 原样累积，
// 进程结束时先严格 UTF-8 解码（node/npm/git 等现代工具输出 UTF-8），
// 含非法序列时回落 GBK 解码（Electron 自带 full-icu，TextDecoder("gbk") 可用）。
const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });
let gbkDecoder: typeof utf8StrictDecoder | null = null;
try {
  gbkDecoder = new TextDecoder("gbk");
} catch {
  // 非 full-ICU 环境无 GBK：最终兜底宽松 UTF-8（替换字符）
}

function decodeShellOutput(chunks: Buffer[]): string {
  if (chunks.length === 0) return "";
  const buf = Buffer.concat(chunks).subarray(0, SHELL_MAX_OUTPUT);
  try {
    return utf8StrictDecoder.decode(buf);
  } catch {
    if (gbkDecoder) {
      try {
        return gbkDecoder.decode(buf);
      } catch {
        // GBK 也解不动（如二进制输出）：落到宽松 UTF-8
      }
    }
    return buf.toString("utf8");
  }
}

interface ShellResult {
  shell: ShellKind;
  shellExecutable?: string;
  errorCode?: "BASH_UNAVAILABLE";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** 遥测字段：是否经沙箱执行。仅用于日志/结果展示，不参与安全判定（判定在 spawn 前的 ExecutionPlan 完成） */
  ranViaSandbox: boolean;
  /** 因 idle/total 超时或外部取消而被强制终止 */
  timedOut: boolean;
}

/** 可靠终止进程树。Windows 上 child.kill("SIGKILL") 只杀直接子进程，杀不掉孙进程。 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    // /T=含整棵子树  /F=强制  砍掉进程树，避免孙进程成为孤儿
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
  } else {
    try { child.kill("SIGKILL"); } catch { /* 已退出则忽略 */ }
  }
}

// ── 执行计划：安全决策与副作用执行分离 ─────────────────────
// 不变量：非 full 档位下，任何命令在 ExecutionPlan 确定为可执行（sandboxed/direct）
// 之前不会触碰 spawn；wrap 失败一律 fail-closed，绝不"先跑完再事后拒绝"
// （旧实现曾在 wrap 抛错时静默直跑、执行完毕后才贴拒绝标签，构成 fail-open 漏洞）。
// rejected 计划在类型层面就进不了 executePlan（见 ExecutablePlan）。
type ExecutionPlan =
  | { kind: "sandboxed"; command: string; cwd?: string; requestedShell: ShellKind; argv: string[]; env: NodeJS.ProcessEnv }
  | { kind: "direct"; command: string; cwd?: string; requestedShell: ShellKind }
  | { kind: "rejected"; command: string; cwd?: string; requestedShell: ShellKind; reason: string };

/** 可执行计划：spawn 只接受这两种，rejected 在类型层面被挡在 executor 之外。 */
type ExecutablePlan = Exclude<ExecutionPlan, { kind: "rejected" }>;

/**
 * spawn 前完成全部安全决策（唯一调用沙箱 wrap 的地方）。
 *
 * 分流规则（按失败原因区分）：
 * - wrap 成功 → sandboxed
 * - wrap 失败 + reason "disabled"（用户显式无沙箱：CYRENE_SRT=0 / 非 Windows）+ read 类命令
 *   → direct（graceful degradation，保留开发环境可用性）
 * - wrap 失败（not_ready / wrap_failed），或 disabled + 写副作用命令，或 wrap 意外抛错
 *   → rejected（fail-closed，无论 read/write 都不执行）
 */
async function resolveExecutionPlan(
  command: string,
  cwd: string | undefined,
  requestedShell: ShellKind,
  resolvedShell: ResolvedShellExecutable,
  requiresSandbox: boolean,
): Promise<ExecutionPlan> {
  const base = { command, cwd, requestedShell };
  let outcome: SandboxWrapOutcome;
  try {
    outcome = await wrapWithSandbox(
      command,
      cwd,
      requestedShell === "bash" ? resolvedShell.executable : undefined,
    );
  } catch (err) {
    // 契约上 wrapWithSandbox 永不抛错；此处兜底防止 API 破约重新打开 fail-open 缺口
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(LogTag.BuiltinTools, `[run_shell] wrapWithSandbox threw unexpectedly, fail-closed: ${detail}`);
    return { ...base, kind: "rejected", reason: "沙箱包装异常，该命令已终止（未执行）" };
  }

  if (outcome.ok) {
    return { ...base, kind: "sandboxed", argv: outcome.argv, env: outcome.env };
  }

  // 用户显式无沙箱 + 只读命令 → 允许降级直跑
  if (outcome.reason === "disabled" && !requiresSandbox) {
    logger.warn(LogTag.BuiltinTools, `[run_shell] sandbox disabled, read-effect fallback to direct ${requestedShell}`);
    return { ...base, kind: "direct" };
  }

  const REJECT_REASON: Record<"disabled" | "not_ready" | "wrap_failed", string> = {
    disabled: "沙箱未启用，该命令可能修改工作区，已终止",
    not_ready: "沙箱不可用（初始化失败），该命令已终止。请在设置中安装沙箱或提升权限档位。",
    wrap_failed: "沙箱包装失败，该命令已终止（未执行）",
  };
  logger.warn(LogTag.BuiltinTools, `[run_shell] fail-closed before spawn: reason=${outcome.reason} detail=${outcome.detail ?? "(none)"} effect=${requiresSandbox ? "write/unknown" : "read"} command="${command.slice(0, 200)}"`);
  return { ...base, kind: "rejected", reason: REJECT_REASON[outcome.reason] };
}

/**
 * 执行一个已通过安全决策的计划。
 *
 * spawn 只存在于本函数；`ranViaSandbox` 仅作遥测（日志/结果字段展示），
 * 不再承担任何安全判定职责（判定已在 resolveExecutionPlan 的 spawn 之前完成）。
 */
function executePlan(
  plan: ExecutablePlan,
  resolvedShell: ResolvedShellExecutable,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    (async () => {
      const requestedShell = plan.requestedShell;
      const command = plan.command;
      const cwd = plan.cwd;

      let spawnCmd: string;
      let spawnArgs: string[];
      let spawnEnv: NodeJS.ProcessEnv;
      let ranViaSandbox = false;
      let directVerbatim = false;
      if (plan.kind === "sandboxed") {
        spawnCmd = plan.argv[0];
        spawnArgs = plan.argv.slice(1);
        // 沙箱 env 是 SRT 给的（含必要的 PATH/token 等）
        spawnEnv = { ...plan.env };
        ranViaSandbox = true;
      } else {
        const directInvocation = buildDirectShellInvocation(resolvedShell, command);
        spawnCmd = directInvocation.command;
        spawnArgs = directInvocation.args;
        spawnEnv = { ...process.env };
        directVerbatim = directInvocation.windowsVerbatimArguments;
      }

      const child = spawn(spawnCmd, spawnArgs, {
        cwd: cwd || undefined,
        shell: false,
        windowsHide: true,
        env: spawnEnv,
        // 直接 cmd.exe 路径必须 verbatim：Node 默认对 argv 做 MSVCRT 转义（" → \"），
        // 而 cmd.exe 的 /s 规则只剥首尾引号、不认 \" 转义，字面引号会传给目标程序——
        // 带引号路径如 node "E:\video test\_check.js" 会变成非法模块名。
        // windowsVerbatimArguments 让 argv 原样空格拼接，引号语义完全交给 cmd。
        // 沙箱路径不加：srt-win 是 Rust 程序（MSVCRT 解析 argv），与 Node 自动转义配对正确。
        ...(ranViaSandbox || !directVerbatim ? {} : { windowsVerbatimArguments: true }),
        // stdin→/dev/null(NUL)：误启动交互式进程(python/node REPL)时让它读到 EOF 立即退出，
        // 不再卡在"等 stdin 输入"上耗满超时。stdout/stderr 仍 pipe 来收集输出。
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Buffer 原样累积（16KB 上限），进程结束时按 UTF-8→GBK 顺序解码（见 decodeShellOutput）
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;

      // ── 双计时器 + 强制收尸 ──────────────────────────────
      // settled 保证只 resolve 一次；close/error/强制收尸任何一方先到都安全。
      let settled = false;
      let idleTimer: NodeJS.Timeout | undefined;
      let totalTimer: NodeJS.Timeout | undefined;
      let killGraceTimer: NodeJS.Timeout | undefined;
      const clearTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        clearTimeout(killGraceTimer);
      };
      const finish = (result: ShellResult) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      type StuckReason = "idle" | "total" | "cancelled";
      const reasonText: Record<StuckReason, string> = {
        idle: `命令连续 ${SHELL_IDLE_TIMEOUT_MS / 60_000} 分钟无任何输出（疑似常驻进程或卡死）`,
        total: `命令超过 ${SHELL_TOTAL_TIMEOUT_MS / 60_000} 分钟总上限`,
        cancelled: "所在任务已被用户取消",
      };
      const onStuck = (reason: StuckReason) => {
        console.warn(LOG_PREFIX, `run_shell 终止(${reason})，kill 进程树:`, command);
        killTree(child);
        // 宽限期后强制收尸：close 事件要求 stdio 管道全关，taskkill 漏杀孙进程时
        // 管道保持打开、close 永不触发。宽限期内 close 正常到达则 finish 已短路。
        killGraceTimer = setTimeout(() => {
          finish({
            shell: requestedShell,
            shellExecutable: resolvedShell.executable,
            exitCode: null,
            stdout: decodeShellOutput(stdoutChunks),
            stderr: decodeShellOutput(stderrChunks)
              + `\n[已终止] ${reasonText[reason]}，进程树已被强制终止。`,
            truncated,
            ranViaSandbox,
            timedOut: true,
          });
        }, SHELL_KILL_GRACE_MS);
      };
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => onStuck("idle"), SHELL_IDLE_TIMEOUT_MS);
      };
      const onAbort = () => onStuck("cancelled");

      totalTimer = setTimeout(() => onStuck("total"), SHELL_TOTAL_TIMEOUT_MS);
      resetIdle();
      if (signal) {
        if (signal.aborted) onStuck("cancelled");
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        resetIdle();
        if (stdoutBytes >= SHELL_MAX_OUTPUT) {
          truncated = true;
          return;
        }
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
        if (stdoutBytes > SHELL_MAX_OUTPUT) truncated = true;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        resetIdle();
        if (stderrBytes >= SHELL_MAX_OUTPUT) {
          truncated = true;
          return;
        }
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
        if (stderrBytes > SHELL_MAX_OUTPUT) truncated = true;
      });
      child.on("error", (err) => {
        finish({
          shell: requestedShell,
          shellExecutable: resolvedShell.executable,
          exitCode: -1,
          stdout: decodeShellOutput(stdoutChunks),
          stderr: decodeShellOutput(stderrChunks) + "\n[spawn error] " + err.message + (ranViaSandbox ? " [sandbox]" : ""),
          truncated,
          ranViaSandbox,
          timedOut: false,
        });
      });
      child.on("close", (code) => {
        finish({
          shell: requestedShell,
          shellExecutable: resolvedShell.executable,
          exitCode: code,
          stdout: decodeShellOutput(stdoutChunks),
          stderr: decodeShellOutput(stderrChunks),
          truncated,
          ranViaSandbox,
          timedOut: false,
        });
      });
    })().catch((err) => {
      // async wrapper 异常兜底（理论上不会走到，wrapWithSandbox 内部已 try/catch，
      // 且安全决策在 resolveExecutionPlan 已完成，此处只影响单次执行的错误上报）
      const msg = err instanceof Error ? err.message : String(err);
      resolve({
        shell: plan.requestedShell,
        exitCode: -1,
        stdout: "",
        stderr: "[executePlan internal error] " + msg,
        truncated: false,
        ranViaSandbox: false,
        timedOut: false,
      });
    });
  });
}

async function executeRunShell(args: Record<string, unknown>, context?: import("../registry/tool-context").ToolContext): Promise<string> {
  const command = String(args.command || "").trim();
  const cwd = args.cwd ? String(args.cwd) : undefined;
  const requestedShell = args.shell === undefined || args.shell === "cmd"
    ? "cmd"
    : args.shell === "bash"
      ? "bash"
      : null;
  if (!command) return "[错误] command 不能为空";
  if (!requestedShell) {
    return JSON.stringify({
      command, cwd, shell: String(args.shell), errorCode: "SHELL_UNSUPPORTED",
      exitCode: -1, stdout: "", stderr: "[SHELL_UNSUPPORTED] shell 仅支持 cmd 或 bash",
      timedOut: false, truncated: false, effect: "unknown", sandboxed: false,
    });
  }

  // 灾难命令守卫：无论档位都拒绝（format/shutdown/dd 等明显灾难操作）
  if (isCatastrophicCommand(command)) {
    logger.info(LogTag.BuiltinTools, `[run_shell] rejected: catastrophic command="${command}"`);
    return JSON.stringify({
      command, cwd, shell: requestedShell,
      exitCode: -1, stdout: "", stderr: "[拒绝] 该命令被系统禁止执行",
      timedOut: false, truncated: false, effect: "unknown", sandboxed: false,
    });
  }

  const level = context?.permissionMode === "allow_all" ? "full" : getCurrentLevel();
  const effect: ShellEffect = classifyShellEffect(command);
  logger.info(LogTag.BuiltinTools, `[run_shell] entry: command="${command}" cwd=${cwd || "(undefined)"} effect=${effect} level=${level}`);

  // 解释器前置解析：直跑和沙箱包装都需要（bash 不可用在此提前返回，不进入执行计划）
  const resolvedShell = await resolveShellExecutable(requestedShell);
  if (!resolvedShell) {
    return JSON.stringify({
      command, cwd, shell: requestedShell, errorCode: "BASH_UNAVAILABLE",
      exitCode: -1, stdout: "",
      stderr: "[BASH_UNAVAILABLE] 未找到可用的 Bash。请安装 Git Bash，并确保 bash.exe 可执行。",
      timedOut: false, truncated: false, effect, sandboxed: false,
    });
  }

  // full 档位：直接 spawn，不走沙箱（用户已选择完全信任）
  if (level === "full") {
    logger.info(LogTag.BuiltinTools, `[run_shell] full level → direct ${requestedShell} (no sandbox)`);
    const result = await executePlan({ kind: "direct", command, cwd, requestedShell }, resolvedShell, context?.signal);
    logger.info(LogTag.BuiltinTools, `[run_shell] [full] done: exitCode=${result.exitCode} timedOut=${result.timedOut} stdout.len=${result.stdout.length} stderr.len=${result.stderr.length}`);
    return JSON.stringify({
      command, cwd, shell: result.shell, shellExecutable: result.shellExecutable, errorCode: result.errorCode,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      truncated: result.truncated,
      effect,
      sandboxed: false,
    });
  }

  // 非 full 档位：spawn 前通过 ExecutionPlan 完成全部安全决策
  // - read  → 仅当"用户显式无沙箱"（reason: disabled）时允许 direct 降级
  // - write/unknown → 必须 wrap 成功，否则 rejected（fail-closed，不执行）
  const requiresSandbox = effect !== "read";
  const plan = await resolveExecutionPlan(command, cwd, requestedShell, resolvedShell, requiresSandbox);

  if (plan.kind === "rejected") {
    // 到达这里时 spawn 从未被调用——命令没有执行过，stdout 必然为空
    return JSON.stringify({
      command, cwd, shell: requestedShell,
      exitCode: -1, stdout: "",
      stderr: `[拒绝] ${plan.reason}`,
      timedOut: false, truncated: false, effect, sandboxed: false,
    });
  }

  const result = await executePlan(plan, resolvedShell, context?.signal);
  logger.info(LogTag.BuiltinTools, `[run_shell] [${level}] done: exitCode=${result.exitCode} timedOut=${result.timedOut} stdout.len=${result.stdout.length} stderr.len=${result.stderr.length} sandboxed=${result.ranViaSandbox}`);
  return JSON.stringify({
    command, cwd, shell: result.shell, shellExecutable: result.shellExecutable, errorCode: result.errorCode,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    truncated: result.truncated,
    effect,
    sandboxed: result.ranViaSandbox,
  });
}

export const runShellTool: ToolDefinition = {
  id: "run_shell",
  name: "执行命令",
  description:
    "在用户电脑上执行一条 Shell 命令字符串。默认由 cmd.exe 解析；需要类 Unix 语法时可显式选择 bash。返回 exitCode + stdout + stderr。\n\n" +
    "cmd 模式语义：\n" +
    "- 管道：git status | findstr TODO\n" +
    "- 重定向：npm run build > build.log 或 echo hello >> out.txt\n" +
    "- 命令串联：cd src && dir 或 git add . && git commit -m msg\n" +
    "- cmd 内建命令：dir / type / echo / del / copy / set 等可直接用\n" +
    "- 环境变量：%VAR% 会被展开\n\n" +
    "bash 模式语义：\n" +
    "- 设置 shell=\"bash\"，可使用 pwd / grep / sed / awk、$VAR、POSIX 管道及脚本语法\n" +
    "- 仅在检测到可用 Git Bash 时执行；不可用会明确返回 BASH_UNAVAILABLE，不会改用 cmd\n\n" +
    "何时用：\n" +
    "- git clone / git status / git log 等版本控制操作\n" +
    "- npm install / npm run / pip install / node xxx.js 等开发操作\n" +
    "- node --version / python --version 等查环境\n" +
    "- 用户明确要求'跑一下这条命令'\n" +
    "- 需要管道/重定向组合的命令\n\n" +
    "不要用于：\n" +
    "- 读文件 → read_file（更安全）\n" +
    "- 列目录 → list_dir\n" +
    "- 搜索代码内容 → search_text\n" +
    "- 下载网页 → fetch_url\n" +
    "- 启动常驻进程（dev server / npx serve / watch / tail -f）→ 本工具只适合跑完就退出的命令，" +
    "常驻进程会在 2 分钟无输出后被强制终止；需要预览服务时，构建完成后告知用户自行启动\n" +
    "- 能用专用工具完成的事\n\n" +
    "安全说明：非完全信任档位下，写副作用的命令会在沙箱中执行（限制文件系统访问范围）。" +
    "灾难命令（format/shutdown/dd 等）一律拒绝。\n" +
    "参数：command (完整命令行字符串，如 \"git status\")，cwd (可选工作目录)，shell (cmd 或 bash，默认 cmd)。",
  enabled: true,
  risk: "shell",
  modes: ["code", "work"],
  effectKind: "unknown" as const,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "完整命令行字符串，如 \"git status\"、\"npm install\"、\"dir | findstr TODO\"" },
      cwd: { type: "string", description: "工作目录绝对路径，可选" },
      shell: {
        type: "string",
        enum: ["cmd", "bash"],
        default: "cmd",
        description: "命令解释器：cmd（默认，兼容旧命令）或 bash（需要用户已安装 Git Bash）",
      },
    },
    required: ["command"],
  },
  execute: executeRunShell,
};

