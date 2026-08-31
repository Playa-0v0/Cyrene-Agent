// ShellExecutionPolicy — 命令副作用分类器 + 灾难守卫
//
// 设计哲学：
// - Classifier（分类器）负责判断 effect → 仅用于 approval / UI / logging / 风险提示
// - Sandbox（沙箱）负责强制能力边界 → OS 级别兜底
// 绝不让 classifier 成为安全边界。
//
// 分类结果：
// - "read"：明确只读命令（git status, ls, echo 等）
// - "write"：明确有写副作用的命令（git commit, npm install, > redirect 等）
// - "unknown"：无法判断（node script.js, some-tool.cmd 等）
//
// 灾难守卫：
// - isCatastrophicCommand() 拦截明显灾难操作（format, shutdown, dd 等）
//   不试图穷举所有危险命令——沙箱才是最终裁判。

/** 命令副作用分类（仅用于 approval / UI / logging，不是安全边界） */
export type ShellEffect = "read" | "write" | "unknown";

// ── 明确只读的命令首词 ──────────────────────────────────

const READ_ONLY_FIRST_WORDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "fd",
  "echo", "pwd", "which", "where", "type", "file", "stat", "du",
  "df", "uname", "hostname", "date", "id", "whoami", "env",
  "sort", "uniq", "cut", "tr", "sed", "awk",
  "dir", "tree", "ver", "vol",  // Windows 只读内建
  // 注：find 不在此列——它有 -delete/-exec 等写参数，单独在下方分支处理
]);

/** git 只读子命令 */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "branch", "remote", "stash",
  "tag", "describe", "rev-parse", "ls-files", "ls-remote",
  "cat-file", "count-objects", "blame",
]);

/** git 写子命令 */
const WRITE_GIT_SUBCOMMANDS = new Set([
  "checkout", "reset", "rebase", "merge", "pull", "push",
  "commit", "add", "rm", "mv", "clean", "am", "apply",
  "cherry-pick", "revert", "init", "clone", "fetch", "archive",
]);

/** git branch 写参数 */
const GIT_BRANCH_WRITE_FLAGS = new Set(["-d", "-D", "-m", "-M", "-c", "-C"]);

/** git stash 写子命令 */
const GIT_STASH_WRITE_SUBCOMMANDS = new Set(["push", "pop", "drop", "clear", "apply", "create"]);

/** git remote 写子命令 */
const GIT_REMOTE_WRITE_SUBCOMMANDS = new Set(["add", "remove", "rename", "set-url", "prune", "update"]);

/** find 写参数 */
const FIND_WRITE_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok"]);

// ── 灾难命令守卫 ────────────────────────────────────────

/** 灾难级命令首词：无论什么档位都直接拒绝 */
const CATASTROPHIC_FIRST_WORDS = new Set([
  "format", "mkfs", "fdisk",
  "shutdown", "reboot", "halt", "poweroff",
  "dd",
]);

// ── 灾难守卫 ────────────────────────────────────────────

/**
 * 灾难命令检测：拦截明显的灾难操作（format / shutdown / dd 等）。
 * 不试图穷举所有危险命令——沙箱才是最终裁判。
 */
export function isCatastrophicCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) return false;
  // 取第一个 token（可能是路径，取 basename），去掉任何文件扩展名（.exe/.cmd/.ext4 等）
  const firstToken = trimmed.split(/\s+/)[0];
  const basename = firstToken.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return CATASTROPHIC_FIRST_WORDS.has(basename);
}

// ── 副作用分类器 ────────────────────────────────────────

/**
 * 分类命令行字符串的副作用。
 *
 * **仅用于 approval / UI / logging / 风险提示，不是安全边界。**
 * 沙箱才是最终裁判：哪怕 classifier 误判为 read，沙箱也会阻止写操作。
 *
 * @param command 完整命令行字符串（如 "git status | findstr TODO"）
 * @returns "read" | "write" | "unknown"
 */
export function classifyShellEffect(command: string): ShellEffect {
  const trimmed = command.trim();
  if (!trimmed) return "unknown";

  // ── 1. 检查 shell 操作符 → write ──
  // 重定向 (> >> <)、管道 (|)、命令连接 (&& || & ;) 中只要出现就视为 write
  // 因为管道后段可能写文件，重定向明确写文件
  if (/[<>]/.test(trimmed) || /\|/.test(trimmed) || /(&&|\|\||[&;])/.test(trimmed)) {
    // 但纯读管道如 "git status | findstr xxx" 实际是 read——
    // 保守起见仍标 write，让 sandbox 兜底；per-action 档会触发审批
    // 代价是 read-only 档跑不了管道，但安全侧失优于功能侧失
    return "write";
  }

  // ── 2. 取首词分析 ──
  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0].toLowerCase();
  const basename = firstToken.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const rest = tokens.slice(1).map((t) => t.toLowerCase());

  // ── 3. 只读命令首词 ──
  if (READ_ONLY_FIRST_WORDS.has(basename)) return "read";

  // ── 4. Git 命令 ──
  if (basename === "git") {
    const subcommand = rest[0];
    if (!subcommand) return "unknown";

    if (subcommand === "branch") {
      if (rest.some((a) => GIT_BRANCH_WRITE_FLAGS.has(a))) return "write";
      return "read";
    }
    if (subcommand === "stash") {
      const stashSub = rest[1];
      if (stashSub && GIT_STASH_WRITE_SUBCOMMANDS.has(stashSub)) return "write";
      return "read";
    }
    if (subcommand === "remote") {
      const remoteSub = rest[1];
      if (remoteSub && GIT_REMOTE_WRITE_SUBCOMMANDS.has(remoteSub)) return "write";
      return "read";
    }
    if (WRITE_GIT_SUBCOMMANDS.has(subcommand)) return "write";
    if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return "read";
    return "unknown";
  }

  // ── 5. find 命令 ──
  if (basename === "find") {
    if (rest.some((a) => FIND_WRITE_FLAGS.has(a))) return "write";
    return "read";
  }

  // ── 6. npm/yarn/pnpm ──
  if (["npm", "yarn", "pnpm", "npx"].includes(basename)) {
    const sub = rest[0];
    if (!sub) return "unknown";
    // install / create / publish / run（可能写）→ write
    const WRITE_SUBS = new Set(["install", "i", "add", "remove", "uninstall", "publish",
      "create", "init", "run", "run-script", "ci", "update", "audit", "fix"]);
    if (WRITE_SUBS.has(sub)) return "write";
    // list / ls / view / info / outdated / why → read
    const READ_SUBS = new Set(["list", "ls", "view", "info", "outdated", "why", "config", "prefix", "root"]);
    if (READ_SUBS.has(sub)) return "read";
    return "unknown";
  }

  // ── 7. 其他已知开发工具 ──
  if (["node", "python", "python3", "py", "ruby", "go", "cargo", "rustc",
       "gcc", "g++", "cl", "msbuild", "tsc", "eslint", "prettier",
       "pip", "pip3", "cargo", "docker", "kubectl"].includes(basename)) {
    // 这些工具可能做任何事——交给沙箱
    return "unknown";
  }

  // ── 8. 未知命令 ──
  return "unknown";
}

// ── 工具执行前策略守卫（保留，供 tool-registry 使用）────────

export interface ExecutionPolicyDecision {
  allowed: boolean;
  errorCode?: string;
  message?: string;
}

/**
 * 执行前策略守卫：在工具实际执行前检查是否允许。
 * 覆盖 Plan 和 Direct 模式。
 */
export function checkExecutionPolicy(
  effectKind: string,
  verificationPolicy: string,
  toolId: string,
): ExecutionPolicyDecision {
  if (effectKind === "unknown") {
    return {
      allowed: false,
      errorCode: "E_UNKNOWN_TOOL_EFFECT",
      message: `工具 ${toolId} 的 effectKind 为 unknown，系统无法确定工具效果类型，拒绝执行。请为该工具配置 effectKind。`,
    };
  }

  if (effectKind === "mutation" && verificationPolicy === "unknown") {
    return {
      allowed: false,
      errorCode: "E_UNKNOWN_VERIFICATION_POLICY",
      message: `工具 ${toolId} 的 verificationPolicy 为 unknown，系统无法确定验证策略，拒绝执行。请为该工具配置 verificationPolicy 或 verificationPolicyResolver。`,
    };
  }

  return { allowed: true };
}
