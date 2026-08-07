import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { memoryStore } from "./memory/memory-store";

export type NotebookCategory = "🌸 陪伴" | "🎵 聽歌" | "📝 筆記" | "💖 悄悄話" | "⚙️ 完成事項" | "📌 綜合";

export interface NotebookEntry {
  id: string;
  dateKey: string;
  dateLabel: string;
  period: "上午" | "下午" | "晚上" | "全天";
  category: NotebookCategory;
  title: string;
  content: string;
  author: string;
  tags: string[];
  rawLine?: string;
  occurredAt?: number;
}

type NotebookListener = (notebookPath: string) => void;
const changeListeners = new Set<NotebookListener>();
let writeLock: Promise<unknown> = Promise.resolve();

export function getSharedNotebookPath(): string {
  if (process.env.CYRENE_SHARED_NOTEBOOK_PATH) {
    return path.resolve(process.env.CYRENE_SHARED_NOTEBOOK_PATH);
  }
  return path.resolve(process.cwd(), "Shared Notebook.md");
}

export function onNotebookChanged(listener: NotebookListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyChanged(notebookPath: string) {
  changeListeners.forEach((fn) => fn(notebookPath));
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

function generateId(source: string): string {
  return createHash("sha1").update(source).digest("hex").slice(0, 12);
}

/**
 * Read and parse Shared Notebook.md into structured entries.
 */
export async function readNotebook(notebookPath = getSharedNotebookPath()): Promise<{ rawContent: string; entries: NotebookEntry[] }> {
  let rawContent = "";
  try {
    rawContent = await fs.readFile(notebookPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    rawContent = "# 🌸 昔漣與夥伴的共享筆記本 🌸\n\n## 📅 成長足跡與共同日誌\n";
  }

  const entries: NotebookEntry[] = [];
  const lines = rawContent.split("\n");
  let currentDateKey = "";
  let currentDateLabel = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Date heading e.g.: ### 📅 2026年7月22日 · 音樂與心靈的共鳴 🌸
    const dateMatch = line.match(/^###\s*[✦📅]?\s*(\d{4}年\d{1,2}月\d{1,2}日)/);
    if (dateMatch) {
      currentDateLabel = dateMatch[1];
      // Convert to key 2026-07-22
      const m = currentDateLabel.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (m) {
        currentDateKey = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
      }
      continue;
    }

    // Bullet line check
    if (line.startsWith("*") || line.startsWith("-")) {
      const parsed = parseLineToEntry(line, currentDateKey, currentDateLabel);
      if (parsed) {
        entries.push(parsed);
      }
    }
  }

  void syncNotebookToL2Memory().catch(() => {});
  return { rawContent, entries };
}

function parseLineToEntry(line: string, defaultDateKey: string, defaultDateLabel: string): NotebookEntry | null {
  // Extract comment ID if present <!-- cyrene-discord:ID -->
  let id = "";
  const idMatch = line.match(/<!--\s*cyrene-discord:([a-f0-9]+)\s*-->/i);
  if (idMatch) {
    id = idMatch[1];
  } else {
    id = generateId(line);
  }

  // Strip list bullet and comment
  const cleanLine = line.replace(/^[*|-]\s*/, "").replace(/<!--\s*cyrene-discord:[^]*?-->/g, "").trim();

  // Match pattern: **Period · Category/Title**，和 Author：Content
  const periodMatch = cleanLine.match(/^\*\*([^\s·*]+)\s*·\s*([^*]+)\*\*(?:，和\s*([^：:]+))?[：:]\s*(.*)$/);

  let period: "上午" | "下午" | "晚上" | "全天" = "全天";
  let category: NotebookCategory = "📌 綜合";
  let author = "昔漣";
  let title = "";
  let content = "";
  let tags: string[] = [];

  if (periodMatch) {
    const rawPeriod = periodMatch[1].trim();
    if (["上午", "下午", "晚上"].includes(rawPeriod)) {
      period = rawPeriod as any;
    }

    const rawCatOrTitle = periodMatch[2].trim();
    if (rawCatOrTitle.includes("聽歌")) {
      category = "🎵 聽歌";
      title = rawCatOrTitle;
    } else if (rawCatOrTitle.includes("日誌") || rawCatOrTitle.includes("陪伴")) {
      category = "🌸 陪伴";
      title = rawCatOrTitle;
    } else if (rawCatOrTitle.includes("筆記") || rawCatOrTitle.includes("學習")) {
      category = "📝 筆記";
      title = rawCatOrTitle;
    } else if (rawCatOrTitle.includes("悄悄話")) {
      category = "💖 悄悄話";
      title = rawCatOrTitle;
    } else if (rawCatOrTitle.includes("完成事項")) {
      category = "⚙️ 完成事項";
      title = rawCatOrTitle;
    } else {
      title = rawCatOrTitle;
    }

    if (periodMatch[3]) author = periodMatch[3].trim();
    content = periodMatch[4].trim();
  } else {
    title = cleanLine.slice(0, 30);
    content = cleanLine;
  }

  // Extract tags e.g. #tag
  const tagMatches = content.match(/#([\w\u4e00-\u9fa5]+)/g);
  if (tagMatches) {
    tags = tagMatches.map((t) => t.slice(1));
  }

  return {
    id,
    dateKey: defaultDateKey || new Date().toISOString().slice(0, 10),
    dateLabel: defaultDateLabel || "今日",
    period,
    category,
    title,
    content,
    author,
    tags,
    rawLine: line,
  };
}

/**
 * Append a new diary/note entry to Shared Notebook.md.
 */
export async function addNotebookEntry(options: {
  category?: NotebookCategory;
  title: string;
  content: string;
  author?: string;
  tags?: string[];
  occurredAt?: Date;
  notebookPath?: string;
}): Promise<NotebookEntry> {
  const notebookPath = options.notebookPath || getSharedNotebookPath();
  const occurredAt = options.occurredAt || new Date();
  const { key: dayKey, label: dayLabel, period } = localDateParts(occurredAt);
  const category = options.category || "🌸 陪伴";
  const author = options.author || "昔漣";
  const tagsStr = options.tags && options.tags.length > 0 ? options.tags.map((t) => `#${t}`).join(" ") : "";
  const fullContent = options.tags && options.tags.length > 0 ? `${options.content} ${tagsStr}` : options.content;

  const id = generateId(`${dayKey}\0${category}\0${options.title}\0${fullContent}`);
  const line = `* **${period} · ${category}**，和 ${author}：**${options.title}** - ${fullContent} <!-- cyrene-discord:${id} -->`;

  return new Promise((resolve, reject) => {
    writeLock = writeLock.then(async () => {
      let notebook = "";
      try {
        notebook = await fs.readFile(notebookPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        notebook = "# 🌸 昔漣與夥伴的共享筆記本 🌸\n\n## 📅 成長足跡與共同日誌\n";
      }

      if (!notebook.includes(`<!-- cyrene-discord:${id} -->`)) {
        const startMarker = `<!-- cyrene-discord-day:${dayKey}:start -->`;
        const endMarker = `<!-- cyrene-discord-day:${dayKey}:end -->`;

        if (notebook.includes(endMarker)) {
          notebook = notebook.replace(endMarker, `${line}\n${endMarker}`);
        } else {
          const section = [
            startMarker,
            `### ✦ ${dayLabel} · 共同足跡`,
            "* **記錄原則**：只收藏今天共同完成、值得回看的事情與回憶。",
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
        notifyChanged(notebookPath);

        // Sync to L2 memory in memory store
        try {
          await memoryStore.addL2Memory({
            content: `【Shared Notebook】${category} - ${options.title}: ${options.content}`,
            triggerText: options.content,
            sourceConversationId: "notebook",
            isPinned: false,
            isSummary: true,
          });
        } catch (e) {
          console.warn("[NotebookManager] Memory sync failed:", e);
        }
      }

      const createdEntry: NotebookEntry = {
        id,
        dateKey: dayKey,
        dateLabel: dayLabel,
        period,
        category,
        title: options.title,
        content: options.content,
        author,
        tags: options.tags || [],
        rawLine: line,
        occurredAt: occurredAt.getTime(),
      };
      resolve(createdEntry);
    }).catch(reject);
  });
}

/**
 * Edit an existing notebook entry in Shared Notebook.md by ID.
 */
export async function updateNotebookEntry(id: string, newContent: string, newTitle?: string, notebookPath = getSharedNotebookPath()): Promise<boolean> {
  return new Promise((resolve, reject) => {
    writeLock = writeLock.then(async () => {
      let notebook = await fs.readFile(notebookPath, "utf8");
      const lines = notebook.split("\n");
      let found = false;

      const newLines = lines.map((line) => {
        if (line.includes(`<!-- cyrene-discord:${id} -->`)) {
          found = true;
          // Modify line content while retaining the ID comment
          return line.replace(/(：\s*)(.*?)(<!--\s*cyrene-discord)/, (_all, prefix, _oldText, suffix) => {
            const titlePart = newTitle ? `**${newTitle}** - ` : "";
            return `${prefix}${titlePart}${newContent} ${suffix}`;
          });
        }
        return line;
      });

      if (found) {
        await fs.writeFile(notebookPath, newLines.join("\n"), "utf8");
        notifyChanged(notebookPath);
      }
      resolve(found);
    }).catch(reject);
  });
}

/**
 * Delete a notebook entry by ID from Shared Notebook.md.
 */
export async function deleteNotebookEntry(id: string, notebookPath = getSharedNotebookPath()): Promise<boolean> {
  return new Promise((resolve, reject) => {
    writeLock = writeLock.then(async () => {
      let notebook = await fs.readFile(notebookPath, "utf8");
      const lines = notebook.split("\n");
      const filtered = lines.filter((line) => !line.includes(`<!-- cyrene-discord:${id} -->`));

      if (filtered.length !== lines.length) {
        await fs.writeFile(notebookPath, filtered.join("\n"), "utf8");
        notifyChanged(notebookPath);
        resolve(true);
      } else {
        resolve(false);
      }
    }).catch(reject);
  });
}

/**
 * Sync all daily memory entries from Shared Notebook.md into memoryStore L2 memory.
 */
export async function syncNotebookToL2Memory(): Promise<number> {
  const notebookPath = getSharedNotebookPath();
  let rawContent = "";
  try {
    rawContent = await fs.readFile(notebookPath, "utf8");
  } catch {
    return 0;
  }

  const sections = rawContent.split(/(?=###)/g);
  let syncedCount = 0;

  try {
    const store = await memoryStore.load();
    const existingL2Contents = new Set((store.l2 || []).map((m) => m.triggerText || m.content));

    for (const sec of sections) {
      const trimmed = sec.trim();
      if (!trimmed.startsWith("###")) continue;

      const lines = trimmed.split("\n");
      const titleLine = lines[0].replace(/^###\s*/, "").replace(/^[✦📅]\s*/, "").trim();

      if (existingL2Contents.has(titleLine)) continue;

      const bodyText = lines
        .slice(1)
        .map((l) => l.replace(/<!--[^]*?-->/g, "").trim())
        .filter(Boolean)
        .join("\n");

      if (!bodyText) continue;

      const summaryContent = `【如我所書】${titleLine}\n${bodyText}`;

      await memoryStore.addL2Memory({
        content: summaryContent,
        triggerText: titleLine,
        sourceConversationId: "notebook",
        isPinned: false,
        isSummary: true,
      });
      existingL2Contents.add(titleLine);
      syncedCount++;
    }
  } catch (e) {
    console.warn("[NotebookManager] Bulk L2 memory sync failed:", e);
  }

  return syncedCount;
}
