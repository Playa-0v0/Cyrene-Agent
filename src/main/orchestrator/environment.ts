// Step 1 — 環境注入
//
// 把"今天是幾號 / 系統是什麼 / 桌面在哪 / 當前權限檔位 / 哪些工具可用"
// 這些模型本來要靠猜的事實，直接以 system 段落的形式餵給它。
// 這一層不解決"模型想不想調工具"，但能消掉"模型不知道桌面真實路徑"
// 這一類低級幻覺，給後續的意圖識別 + tool_choice 兜底打底。
//
// 輸出格式刻意選擇 Markdown 小節，方便 LLM 抓字段；同時在終端打印
// `[Env]` 日誌便於排障。

import { app } from "electron";
import * as os from "os";
import { toolRegistry } from "./tool-registry";
import { listMcpServers } from "./mcp-manager";
import { ACCESS_LEVEL_LABEL, getCurrentLevel, policyFor } from "../permission";
import type { ToolRiskLevel } from "../permission";
import { getCapability } from "./vendors/capabilities";

const LOG_PREFIX = "[Env]";

/** 當前模型信息（用於查 capability 判斷視覺等能力），可選。 */
export interface ModelInfo {
  provider: string;
  model: string;
  baseUrl?: string;
}

export function modelSupportsVision(modelInfo?: ModelInfo): boolean {
  if (!modelInfo) return false;
  const cap = getCapability(modelInfo.provider);
  if (cap?.supportsVision) return true;
  // 設定頁的 OpenRouter Free 沿用 Custom profile key；Router 會依 image_url 自動篩視覺模型。
  return /openrouter\.ai/i.test(modelInfo.baseUrl ?? "") || /^openrouter\//i.test(modelInfo.model);
}

/** 用戶信息片段（由 index.ts 注入，避免循環依賴）。 */
export interface UserInfoContext {
  nickname?: string;
  callPreference?: string;
  birthday?: string;
  defaultCity?: string;
  timezone?: string;
}

function safeGetPath(name: "desktop" | "documents" | "downloads" | "home"): string {
  try {
    return app.getPath(name);
  } catch (err) {
    console.warn(LOG_PREFIX, "getPath 失敗:", name, err);
    return "";
  }
}

function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const week = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"][d.getDay()];
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${week} ${hh}:${min}`;
}

function platformLabel(): string {
  const p = process.platform;
  if (p === "win32") return `Windows (${os.release()})`;
  if (p === "darwin") return `macOS (${os.release()})`;
  if (p === "linux") return `Linux (${os.release()})`;
  return `${p} (${os.release()})`;
}

/**
 * 構造環境上下文，作為 system prompt 的尾段拼入。
 *
 * 注意：這裡只讀取既有運行時狀態，不做任何副作用；調用方負責 try/catch
 * 拼接失敗的情況，避免環境注入炸掉聊天主流程。
 */
export function buildEnvironmentContext(modelInfo?: ModelInfo, userInfo?: UserInfoContext): string {
  const level = getCurrentLevel();
  const levelLabel = ACCESS_LEVEL_LABEL[level];

  const desktop = safeGetPath("desktop");
  const documents = safeGetPath("documents");
  const downloads = safeGetPath("downloads");
  const home = safeGetPath("home");
  const username = os.userInfo().username;
  const dateStr = formatDate(new Date());
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";

  // 工具清單：按"啟用 + 當前檔位放行"兩個維度過濾，讓模型只看到當下能用的
  const allEnabled = toolRegistry.getEnabledTools();
  const allowedTools: string[] = [];
  const askTools: string[] = [];
  const deniedTools: string[] = [];
  for (const t of allEnabled) {
    const risk: ToolRiskLevel = t.risk ?? "safe";
    const verdict = policyFor(level, risk);
    if (verdict === "allow") allowedTools.push(`${t.id}(${risk})`);
    else if (verdict === "ask") askTools.push(`${t.id}(${risk})`);
    else deniedTools.push(`${t.id}(${risk})`);
  }

  // MCP server 狀態
  let mcpLine = "未連接任何 MCP server";
  try {
    const servers = listMcpServers();
    if (servers.length > 0) {
      mcpLine = servers
        .map((s) => `${s.name}[${s.connected ? "已連接" : "未連接"}, ${s.toolCount} 工具]`)
        .join(", ");
    }
  } catch (err) {
    console.warn(LOG_PREFIX, "列 MCP server 失敗:", err);
  }

  const lines: string[] = [];
  lines.push("## 運行環境（機器實際狀態，不要再憑印象猜）");
  lines.push("");
  lines.push(`- 當前時間：${dateStr}（時區 ${tz}）`);
  lines.push(`- 操作系統：${platformLabel()}`);
  lines.push(`- 當前用戶名：${username}`);
  if (home) lines.push(`- 用戶主目錄：${home}`);
  if (desktop) lines.push(`- 桌面路徑：${desktop}`);
  if (documents) lines.push(`- 文檔路徑：${documents}`);
  if (downloads) lines.push(`- 下載路徑：${downloads}`);
  lines.push("");
  lines.push(`- 文件權限檔位：${levelLabel}（${level}）`);
  lines.push(`- 當前檔位下可直接調用的工具：${allowedTools.length > 0 ? allowedTools.join(", ") : "（無）"}`);
  if (askTools.length > 0) {
    lines.push(`- 當前檔位需先彈審批的工具：${askTools.join(", ")}`);
  }
  if (deniedTools.length > 0) {
    lines.push(`- 當前檔位被拒絕的工具（提到也調不出）：${deniedTools.join(", ")}`);
  }
  lines.push(`- MCP 服務：${mcpLine}`);
  lines.push("");

  // 模型能力邊界：把"你當前這個模型能不能看圖"作為事實告訴模型，
  // 讓它遇到圖片問題時敢於說"我看不了"，而不是硬編。
  // 沒傳 modelInfo（比如降級路徑）時保守地告訴它"看不了"。
  const supportsVision = modelSupportsVision(modelInfo);
  lines.push(`- 當前模型是否支持查看圖片：${supportsVision ? "支持（可調 read_image 看圖）" : "不支持（看不了圖片，遇到圖片問題必須如實說明，不許編造圖片內容）"}`);
  lines.push("");

  // 用戶信息：暱稱、稱呼偏好、生日、默認城市等。讓模型知道"在和誰說話、用戶在哪"，
  // 避免每次問天氣/位置都要反問用戶。默認城市尤其重要——天氣工具會用到。
  if (userInfo) {
    lines.push("## 用戶信息");
    lines.push("");
    if (userInfo.callPreference) {
      lines.push(`- 稱呼偏好：${userInfo.callPreference}（稱呼用戶時優先用這個）`);
    } else if (userInfo.nickname) {
      lines.push(`- 暱稱：${userInfo.nickname}（稱呼用戶時用這個）`);
    }
    if (userInfo.birthday) lines.push(`- 生日：${userInfo.birthday}`);
    if (userInfo.defaultCity) lines.push(`- 默認城市：${userInfo.defaultCity}（用戶問天氣/位置且沒指定其他城市時，默認用這個）`);
    if (userInfo.timezone && userInfo.timezone !== tz) lines.push(`- 用戶時區：${userInfo.timezone}`);
    lines.push("");
  }

  lines.push(
    "當用戶提到「桌面 / 文檔 / 下載」卻沒給絕對路徑時，使用上面這些真實路徑拼接，再交給文件類工具；不要寫 `~/Desktop` 或硬編碼盤符。",
  );

  const text = lines.join("\n");

  console.log(
    LOG_PREFIX,
    `level=${level}`,
    `desktop=${desktop || "?"}`,
    `allowed=${allowedTools.length}`,
    `ask=${askTools.length}`,
    `deny=${deniedTools.length}`,
    `mcp=${mcpLine.startsWith("未連接") ? "none" : "active"}`,
    `vision=${supportsVision}`,
  );

  return text;
}
