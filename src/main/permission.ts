// 文件/工具權限檔位 — 控制 agent 能做什麼
// 四檔：read-only / scoped / per-action / full
// 未來 fetch_url、run_shell、install_mcp_server 等"危險工具"都要先過 checkPermission

import { ipcMain, BrowserWindow } from "electron";
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../shared/ipc-channels";

const LOG_PREFIX = "[Permission]";

export type AgentFileAccessLevel = "read-only" | "scoped" | "per-action" | "full";

export const ACCESS_LEVEL_LABEL: Record<AgentFileAccessLevel, string> = {
  "read-only": "只讀",
  "scoped": "指定目錄",
  "per-action": "每次審批",
  "full": "完全訪問",
};

// 工具危險等級：決定該工具在哪些檔位下可用
// input-control（鍵鼠/截屏控制）按 shell 同檔處理：read-only/scoped 拒絕，per-action 審批，full 允許
export type ToolRiskLevel = "safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control";

/**
 * 給定檔位 + 工具危險等級 → 返回授權策略：
 *   - "allow"       直接放行
 *   - "ask"         彈審批 UI，用戶點同意才放行
 *   - "deny"        直接拒絕（agent 會收到拒絕原因）
 */
export function policyFor(level: AgentFileAccessLevel, risk: ToolRiskLevel): "allow" | "ask" | "deny" {
  // safe 工具（純計算、純檢索本地內置數據）任何檔位都允許
  if (risk === "safe") return "allow";

  switch (level) {
    case "read-only":
      return risk === "fs-read" || risk === "network" ? "allow" : "deny";
    case "scoped":
      // 指定目錄檔：fs 讀寫允許（具體路徑校驗在工具內部做），shell 拒絕
      if (risk === "fs-read" || risk === "fs-write" || risk === "network") return "allow";
      return "deny";
    case "per-action":
      // 每次審批：除 safe 外都彈審批
      return "ask";
    case "full":
      return "allow";
  }
}

// ── 當前檔位的內存緩存（main 進程持有） ───────────────────
let currentLevel: AgentFileAccessLevel = "read-only";

export function getCurrentLevel(): AgentFileAccessLevel {
  return currentLevel;
}

export function setCurrentLevel(level: AgentFileAccessLevel): void {
  if (currentLevel === level) return;
  console.log(LOG_PREFIX, "檔位切換:", currentLevel, "→", level);
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
    console.error(LOG_PREFIX, "持久化檔位失敗:", err);
  }
}

/**
 * 啟動時從磁盤加載上次保存的檔位；不存在則用默認 read-only。
 * 必須在 app.whenReady 之後調用（依賴 app.getPath）。
 */
export function initPermissionFromDisk(): void {
  try {
    const filePath = getStorePath();
    if (!fs.existsSync(filePath)) {
      console.log(LOG_PREFIX, "未找到持久化檔位文件，使用默認 read-only");
      return;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { level?: unknown };
    if (isValidLevel(raw?.level)) {
      currentLevel = raw.level;
      console.log(LOG_PREFIX, "從磁盤加載檔位:", currentLevel);
    } else {
      console.warn(LOG_PREFIX, "檔位文件內容無效，回退默認");
    }
  } catch (err) {
    console.error(LOG_PREFIX, "加載檔位失敗:", err);
  }
}

// ── 審批彈窗（per-action 檔位下使用） ─────────────────────
// 通過 IPC 把審批請求發到任意一個有焦點的窗口（一般是 chat 或 settings），
// 渲染端彈一個卡片，用戶點同意/拒絕後回傳結果。

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
}

/**
 * 向用戶發起一次審批請求，等用戶點同意/拒絕。
 * 60 秒不響應自動拒絕。
 */
export function requestApproval(request: Omit<ApprovalRequest, "id">): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const id = "approve-" + (++approvalCounter) + "-" + Date.now();
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      console.warn(LOG_PREFIX, "審批超時（60s 未響應），自動拒絕:", request.toolId);
      resolve(false);
    }, 60_000);
    pendingApprovals.set(id, { resolve, reject, timer });

    const payload: ApprovalRequest = { id, ...request };
    console.log(LOG_PREFIX, "向渲染端發送審批請求:", id, request.toolId);

    // 廣播給所有窗口（chat 窗口會優先顯示卡片）
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) {
      // 沒有窗口可以審批 → 直接拒絕
      clearTimeout(timer);
      pendingApprovals.delete(id);
      console.warn(LOG_PREFIX, "無窗口可審批，自動拒絕");
      resolve(false);
      return;
    }
    for (const win of wins) {
      win.webContents.send(IPC.PERMISSION_APPROVAL_REQUEST, payload);
    }
  });
}

// ── IPC 註冊 ──────────────────────────────────────────────

export function registerPermissionIpc(): void {
  ipcMain.handle(IPC.PERMISSION_GET_LEVEL, () => {
    return { level: currentLevel };
  });

  ipcMain.handle(IPC.PERMISSION_SET_LEVEL, (_event, level: AgentFileAccessLevel) => {
    if (!isValidLevel(level)) {
      return { ok: false, error: "無效的檔位: " + String(level) };
    }
    setCurrentLevel(level);
    return { ok: true, level: currentLevel };
  });

  // 渲染端審批 UI 回傳結果
  ipcMain.handle(IPC.PERMISSION_APPROVAL_RESOLVE, (_event, payload: { id: string; allowed: boolean }) => {
    const pending = pendingApprovals.get(payload?.id);
    if (!pending) {
      console.warn(LOG_PREFIX, "審批迴傳未匹配到 pending:", payload?.id);
      return { ok: false };
    }
    clearTimeout(pending.timer);
    pendingApprovals.delete(payload.id);
    console.log(LOG_PREFIX, "審批結果:", payload.id, payload.allowed ? "同意" : "拒絕");
    pending.resolve(Boolean(payload.allowed));
    return { ok: true };
  });

  console.log(LOG_PREFIX, "IPC handlers 已註冊");
}

function isValidLevel(value: unknown): value is AgentFileAccessLevel {
  return value === "read-only" || value === "scoped" || value === "per-action" || value === "full";
}

/**
 * 一站式權限檢查：根據當前檔位 + 工具危險等級，決定執行/審批/拒絕。
 * - allow → 返回 true
 * - ask   → 觸發審批，等用戶回應
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
      reason: "當前檔位「" + ACCESS_LEVEL_LABEL[level] + "」不允許此操作（risk=" + input.risk + "）。請到設置 → 昔漣 → 本地文件權限提升檔位。",
    };
  }
  // ask → 彈審批
  const approved = await requestApproval({
    toolId: input.toolId,
    toolName: input.toolName,
    toolDescription: input.toolDescription,
    args: input.args,
    risk: input.risk,
  });
  if (approved) return { allowed: true };
  return { allowed: false, reason: "用戶拒絕了此次操作。" };
}
