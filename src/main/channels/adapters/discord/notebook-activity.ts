import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolCallResult } from "../../../orchestrator/types";

export interface DiscordMusicNotebookEntry {
  title: string;
  url: string;
  playlistTitle?: string;
  companionName?: string;
  occurredAt?: Date;
}

export interface DiscordActionNotebookContext {
  companionName?: string;
  occurredAt?: Date;
}

export interface DiscordNotebookAction {
  label: string;
  detail?: string;
  sourceKey: string;
}

type NotebookChangedListener = (notebookPath: string) => void;

const listeners = new Set<NotebookChangedListener>();
let writeQueue: Promise<void> = Promise.resolve();

export function getSharedNotebookPath(): string {
  return process.env.CYRENE_SHARED_NOTEBOOK_PATH
    ? path.resolve(process.env.CYRENE_SHARED_NOTEBOOK_PATH)
    : path.resolve(process.cwd(), "我們共同的筆記本.md");
}

export function onSharedNotebookChanged(listener: NotebookChangedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]]/g, "\\$&").replace(/\r?\n/g, " ").trim();
}

function companionLabel(name?: string): "YuYing" | "夥伴" {
  return name && /yu[\s_-]*ying/i.test(name) ? "YuYing" : "夥伴";
}

function localDateParts(date: Date): { key: string; label: string; period: "上午" | "下午" | "晚上" } {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = Number(get("hour")) % 24;
  return {
    key: `${year}-${month}-${day}`,
    label: `${year}年${Number(month)}月${Number(day)}日`,
    period: hour >= 5 && hour < 12 ? "上午" : hour >= 12 && hour < 18 ? "下午" : "晚上",
  };
}

function entryId(entry: DiscordMusicNotebookEntry, dayKey: string): string {
  return createHash("sha1")
    .update(`${dayKey}\0${entry.url}\0${entry.title}`)
    .digest("hex")
    .slice(0, 12);
}

function musicLine(entry: DiscordMusicNotebookEntry, period: "上午" | "下午" | "晚上", id: string): string {
  const title = escapeMarkdown(entry.title) || "未命名歌曲";
  const companion = `，和 ${companionLabel(entry.companionName)}`;
  return `* **${period} · 一起聽歌**${companion}：[${title}](${entry.url}) <!-- cyrene-discord:${id} -->`;
}

const ACTION_LABELS: Record<string, string> = {
  write_file: "儲存文字檔案",
  write_markdown: "完成 Markdown 筆記",
  write_word: "完成 Word 文件",
  write_excel: "完成 Excel 活頁簿",
  write_pdf: "完成 PDF 文件",
  apply_patch: "修改程式或文件",
  send_email: "寄出郵件",
  record_expense: "記下一筆支出",
  install_mcp_server: "安裝工具服務",
  game_bot_start: "啟動遊戲協助",
};

function usefulArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** 僅允許有持久結果的工具；查詢、搜尋、時間、天氣與內部規劃一律不記。 */
export function selectDiscordNotebookAction(result: ToolCallResult): DiscordNotebookAction | null {
  const label = ACTION_LABELS[result.toolId];
  if (!label || /^\[(?:錯誤|工具執行失敗|已拒絕)\]/.test(result.output.trim())) return null;
  const rawDetail = result.toolId === "record_expense"
    ? [usefulArg(result.args, ["note", "category"]), typeof result.args.amount === "number" ? `${result.args.amount} 元` : undefined]
      .filter(Boolean).join(" · ")
    : result.toolId === "send_email"
      ? usefulArg(result.args, ["subject"])
    : result.toolId === "game_bot_start"
      ? usefulArg(result.args, ["recipeId", "recipe", "name"])
      : usefulArg(result.args, ["outputPath", "output_path", "path", "filePath", "filename", "title", "name", "id"]);
  const detail = rawDetail
    ? (/[\\/]/.test(rawDetail) ? path.basename(rawDetail) : rawDetail).slice(0, 100)
    : undefined;
  return {
    label,
    detail,
    sourceKey: `${result.toolId}\0${JSON.stringify(result.args)}\0${result.output}`,
  };
}

function actionLine(action: DiscordNotebookAction, context: DiscordActionNotebookContext, period: "上午" | "下午" | "晚上", id: string): string {
  const companion = `，和 ${companionLabel(context.companionName)}`;
  const detail = action.detail ? `「${escapeMarkdown(action.detail)}」` : "";
  return `* **${period} · 完成事項**${companion}：${action.label}${detail} <!-- cyrene-discord:${id} -->`;
}

async function appendDailyLine(
  line: string,
  id: string,
  occurredAt: Date,
  notebookPath: string,
): Promise<boolean> {
  const { key, label } = localDateParts(occurredAt);
  let notebook = "";
  try {
    notebook = await fs.readFile(notebookPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    notebook = "# 🌸 昔漣與你的共同筆記本 🌸\n\n## 📅 成長足跡與協作日記\n";
  }
  if (notebook.includes(`<!-- cyrene-discord:${id} -->`)) return false;
  const startMarker = `<!-- cyrene-discord-day:${key}:start -->`;
  const endMarker = `<!-- cyrene-discord-day:${key}:end -->`;
  if (notebook.includes(endMarker)) {
    notebook = notebook.replace(endMarker, `${line}\n${endMarker}`);
  } else {
    const section = [
      startMarker,
      `### ✦ ${label} · Discord 共同足跡`,
      "* **記錄原則**：只收藏今天共同完成、值得回看的事情。",
      line,
      endMarker,
      "",
      "---",
      "",
    ].join("\n");
    notebook = `${notebook.trimEnd()}\n\n${section}`;
  }
  await fs.mkdir(path.dirname(notebookPath), { recursive: true });
  await fs.writeFile(notebookPath, notebook, "utf8");
  return true;
}

async function appendMusicEntry(
  entry: DiscordMusicNotebookEntry,
  notebookPath: string,
): Promise<boolean> {
  const occurredAt = entry.occurredAt ?? new Date();
  const { key, period } = localDateParts(occurredAt);
  const id = entryId(entry, key);
  const line = musicLine(entry, period, id);
  return appendDailyLine(line, id, occurredAt, notebookPath);
}

export function recordDiscordMusicInNotebook(
  entry: DiscordMusicNotebookEntry,
  notebookPath = getSharedNotebookPath(),
): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const changed = await appendMusicEntry(entry, notebookPath);
    if (changed) listeners.forEach((listener) => listener(notebookPath));
  }).catch((error) => {
    console.error("[DiscordNotebook] Failed to record music:", error);
  });
  return writeQueue;
}

export function recordDiscordToolActionsInNotebook(
  results: ToolCallResult[],
  context: DiscordActionNotebookContext,
  notebookPath = getSharedNotebookPath(),
): Promise<void> {
  const actions = results.map(selectDiscordNotebookAction).filter((action): action is DiscordNotebookAction => !!action);
  if (!actions.length) return Promise.resolve();
  writeQueue = writeQueue.then(async () => {
    for (const action of actions) {
      const occurredAt = context.occurredAt ?? new Date();
      const { key, period } = localDateParts(occurredAt);
      const id = createHash("sha1").update(`${key}\0${action.sourceKey}`).digest("hex").slice(0, 12);
      const changed = await appendDailyLine(actionLine(action, context, period, id), id, occurredAt, notebookPath);
      if (changed) listeners.forEach((listener) => listener(notebookPath));
    }
  }).catch((error) => {
    console.error("[DiscordNotebook] Failed to record action:", error);
  });
  return writeQueue;
}
