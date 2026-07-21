// 文件/工具权限档位 — 控制 agent 能做什么
// 四档：read-only / scoped / per-action / full
// 未来 fetch_url、run_shell、install_mcp_server 等"危险工具"都要先过 checkPermission

import { ipcMain, BrowserWindow } from "electron";
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../shared/ipc-channels";
import { getTimeoutSettings } from "./timeout-manager";

const LOG_PREFIX = "[Permission]";

export type AgentFileAccessLevel = "read-only" | "scoped" | "per-action" | "full";

export const ACCESS_LEVEL_LABEL: Record<AgentFileAccessLevel, string> = {
  "read-only": "只读",
  "scoped": "指定目录",
  "per-action": "每次审批",
  "full": "完全访问",
};

// 工具危险等级：决定该工具在哪些档位下可用
// input-control（键鼠/截屏控制）按 shell 同档处理：read-only/scoped 拒绝，per-action 审批，full 允许
export type ToolRiskLevel = "safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control";

/**
 * 给定档位 + 工具危险等级 → 返回授权策略：
 *   - "allow"       直接放行
 *   - "ask"         弹审批 UI，用户点同意才放行
 *   - "deny"        直接拒绝（agent 会收到拒绝原因）
 */
export function policyFor(level: AgentFileAccessLevel, risk: ToolRiskLevel): "allow" | "ask" | "deny" {
  // safe 工具（纯计算、纯检索本地内置数据）任何档位都允许
  if (risk === "safe") return "allow";

  switch (level) {
    case "read-only":
      return risk === "fs-read" || risk === "network" ? "allow" : "deny";
    case "scoped":
      // 指定目录档：fs 读写允许（具体路径校验在工具内部做），shell 拒绝
      if (risk === "fs-read" || risk === "fs-write" || risk === "network") return "allow";
      return "deny";
    case "per-action":
      // 每次审批：除 safe 外都弹审批
      return "ask";
    case "full":
      return "allow";
  }
}

// ── 当前档位的内存缓存（main 进程持有） ───────────────────
let currentLevel: AgentFileAccessLevel = "read-only";

export function getCurrentLevel(): AgentFileAccessLevel {
  return currentLevel;
}

export function setCurrentLevel(level: AgentFileAccessLevel): void {
  if (currentLevel === level) return;
  console.log(LOG_PREFIX, "档位切换:", currentLevel, "→", level);
  currentLevel = level;
  persistLevel(level);
}

// ── 持久化 ────────────────────────────────────────────────

function getStorePath(): string {
  return path.join(app.getPath("userData"), "agent-permission.json");
}

function persistLevel(level: AgentFileAccessLevel): void {
  try {
    const filePath = getStorePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ level }, null, 2), "utf8");
  } catch (err) {
    console.error(LOG_PREFIX, "持久化档位失败:", err);
  }
}

/**
 * 启动时从磁盘加载上次保存的档位；不存在则用默认 read-only。
 * 必须在 app.whenReady 之后调用（依赖 app.getPath）。
 */
export function initPermissionFromDisk(): void {
  try {
    const filePath = getStorePath();
    if (!fs.existsSync(filePath)) {
      console.log(LOG_PREFIX, "未找到持久化档位文件，使用默认 read-only");
      return;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { level?: unknown };
    if (isValidLevel(raw?.level)) {
      currentLevel = raw.level;
      console.log(LOG_PREFIX, "从磁盘加载档位:", currentLevel);
    } else {
      console.warn(LOG_PREFIX, "档位文件内容无效，回退默认");
    }
  } catch (err) {
    console.error(LOG_PREFIX, "加载档位失败:", err);
  }
}

// ── 审批弹窗（per-action 档位下使用） ─────────────────────
// 通过 IPC 把审批请求发到任意一个有焦点的窗口（一般是 chat 或 settings），
// 渲染端弹一个卡片，用户点同意/拒绝后回传结果。

interface PendingApproval {
  resolve: (allowed: boolean) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const pendingApprovals = new Map<string, PendingApproval>();
let approvalCounter = 0;

export interface ApprovalRequest {
  id: string;
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: ToolRiskLevel;
  timeoutMs: number;
}

/**
 * 向用户发起一次审批请求，等用户点同意/拒绝。
 * 60 秒不响应自动拒绝。
 */
export function requestApproval(request: Omit<ApprovalRequest, "id">): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const id = "approve-" + (++approvalCounter) + "-" + Date.now();
    const timeout = getTimeoutSettings().userChoiceTimeout;
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      console.warn(LOG_PREFIX, `审批超时（${timeout}ms 未响应），自动拒绝:`, request.toolId);
      resolve(false);
    }, timeout);
    pendingApprovals.set(id, { resolve, reject, timer });

    const payload: ApprovalRequest = { id, ...request };
    console.log(LOG_PREFIX, "向渲染端发送审批请求:", id, request.toolId);

    // 广播给所有窗口（chat 窗口会优先显示卡片）
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) {
      // 没有窗口可以审批 → 直接拒绝
      clearTimeout(timer);
      pendingApprovals.delete(id);
      console.warn(LOG_PREFIX, "无窗口可审批，自动拒绝");
      resolve(false);
      return;
    }
    for (const win of wins) {
      win.webContents.send(IPC.PERMISSION_APPROVAL_REQUEST, payload);
    }
  });
}

// ── IPC 注册 ──────────────────────────────────────────────

export function registerPermissionIpc(): void {
  ipcMain.handle(IPC.PERMISSION_GET_LEVEL, () => {
    return { level: currentLevel };
  });

  ipcMain.handle(IPC.PERMISSION_SET_LEVEL, (_event, level: AgentFileAccessLevel) => {
    if (!isValidLevel(level)) {
      return { ok: false, error: "无效的档位: " + String(level) };
    }
    setCurrentLevel(level);
    return { ok: true, level: currentLevel };
  });

  // 渲染端审批 UI 回传结果
  ipcMain.handle(IPC.PERMISSION_APPROVAL_RESOLVE, (_event, payload: { id: string; allowed: boolean }) => {
    const pending = pendingApprovals.get(payload?.id);
    if (!pending) {
      console.warn(LOG_PREFIX, "审批回传未匹配到 pending:", payload?.id);
      return { ok: false };
    }
    clearTimeout(pending.timer);
    pendingApprovals.delete(payload.id);
    console.log(LOG_PREFIX, "审批结果:", payload.id, payload.allowed ? "同意" : "拒绝");
    pending.resolve(Boolean(payload.allowed));
    return { ok: true };
  });

  console.log(LOG_PREFIX, "IPC handlers 已注册");
}

function isValidLevel(value: unknown): value is AgentFileAccessLevel {
  return value === "read-only" || value === "scoped" || value === "per-action" || value === "full";
}

/**
 * 一站式权限检查：根据当前档位 + 工具危险等级，决定执行/审批/拒绝。
 * - allow → 返回 true
 * - ask   → 触发审批，等用户回应
 * - deny  → 返回 false
 */
export async function checkPermission(input: {
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: ToolRiskLevel;
}): Promise<{ allowed: boolean; reason?: string }> {
  const level = currentLevel;
  const policy = policyFor(level, input.risk);
  console.log(LOG_PREFIX, "checkPermission:", input.toolId, "risk=" + input.risk, "level=" + level, "→", policy);

  if (policy === "allow") return { allowed: true };
  if (policy === "deny") {
    return {
      allowed: false,
      reason: "当前档位「" + ACCESS_LEVEL_LABEL[level] + "」不允许此操作（risk=" + input.risk + "）。请到设置 → 昔涟 → 本地文件权限提升档位。",
    };
  }
  // ask → 弹审批
  const approved = await requestApproval({
    toolId: input.toolId,
    toolName: input.toolName,
    toolDescription: input.toolDescription,
    args: input.args,
    risk: input.risk,
    timeoutMs: getTimeoutSettings().userChoiceTimeout,
  });
  if (approved) return { allowed: true };
  return { allowed: false, reason: "用户拒绝了此次操作。" };
}
