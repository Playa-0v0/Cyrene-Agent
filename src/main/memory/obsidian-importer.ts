// Obsidian Vault → PMRS 回流（阶段2：双向同步）
//
// 监听 `<vault>/记忆/` 目录，用户在 Obsidian 里编辑某条记忆 md 后，
// 防抖 2s 解析变化文件，提取 frontmatter 中的 id 与正文 content，
// 回写到对应 L2Memory.content。只回流正文，不触碰 status/weight/createdAt 等运行时字段。
//
// 循环防护：写回前 setImportingMemory(true)，memoryStore.save() 触发的
// notifyMemoryChanged() 据此跳过 PMRS→Obsidian 同步；写回后复位。
// 叠加 content 比较（无变化不写）确保任何时序下都不会死循环。

import * as fs from "fs";
import * as path from "path";
import { memoryStore } from "./memory-store";
import { setImportingMemory } from "./obsidian-sync-flag";
import { logger, LogTag } from "../logger";
import type { L2Memory } from "./memory-types";

const L2_DIR = "记忆";
const RELATIONS_HEADING = "## 关联";
const IMPORT_DEBOUNCE_MS = 2000;

// ── 解析 ──

/** 从 YAML frontmatter 行中取出 id 值（去引号） */
function extractIdFromFrontmatter(fmLines: string[]): string | null {
  for (const raw of fmLines) {
    const m = raw.match(/^id:\s*(.+)$/);
    if (!m) continue;
    let v = m[1].trim();
    // yamlString 用双引号包裹含特殊字符的值
    if (v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return null;
}

export interface ParsedL2Markdown {
  id: string | null;
  /** 正文 content；null 表示结构无法识别（无 frontmatter 或无标题） */
  content: string | null;
}

/**
 * 解析 vault 中的 L2 md 文件，提取 id（frontmatter）与正文 content。
 *
 * 文件结构（由 obsidian-exporter.buildL2Markdown 生成）：
 * ```
 * ---
 * id: <id>
 * ...其他 frontmatter
 * ---
 *
 * # <首行标题>
 *
 * <正文 content>
 *
 * ## 关联   (可选)
 * - ...
 * ```
 *
 * 正文 = 标题之后、到 `## 关联` 或文件末尾之间的内容，去掉首尾空白。
 */
export function parseL2Markdown(md: string): ParsedL2Markdown {
  const lines = md.split(/\r?\n/);

  // 1. frontmatter
  let id: string | null = null;
  let bodyStart = 0;
  if (lines.length > 0 && lines[0].trim() === "---") {
    const fmLines: string[] = [];
    let i = 1;
    for (; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        bodyStart = i + 1;
        break;
      }
      fmLines.push(lines[i]);
    }
    id = extractIdFromFrontmatter(fmLines);
  }

  if (bodyStart === 0) {
    return { id, content: null }; // 无 frontmatter，不回流
  }
  if (!id) {
    return { id: null, content: null }; // 有 frontmatter 但无 id，无法映射回 L2
  }

  // 2. 正文：跳到第一个一级标题（# xxx，非 ## xxx）
  const body = lines.slice(bodyStart);
  let contentStart = -1;
  for (let i = 0; i < body.length; i++) {
    const t = body[i].trim();
    if (t.startsWith("# ") && !t.startsWith("## ")) {
      contentStart = i + 1;
      break;
    }
  }
  if (contentStart === -1) {
    return { id, content: null };
  }

  // 跳过标题后由导出器写入的空行分隔（body 里标题紧跟一个空行再是正文）
  while (contentStart < body.length && body[contentStart] === "") {
    contentStart++;
  }

  // 3. 正文末尾：遇到 `## 关联` 或 EOF
  let contentEnd = body.length;
  for (let i = contentStart; i < body.length; i++) {
    if (body[i].trim() === RELATIONS_HEADING) {
      contentEnd = i;
      break;
    }
  }

  const content = body.slice(contentStart, contentEnd).join("\n").trimEnd();
  return { id, content };
}

// ── 回写 ──

export interface ImportResult {
  id: string | null;
  /** 是否成功解析并尝试回写（即使内容未变也算 ok） */
  ok: boolean;
  reason?: "deleted" | "no-frontmatter-id" | "no-content" | "not-found";
  /** 实际是否修改了 PMRS 中的记忆内容（content 发生变化） */
  changed: boolean;
}

/**
 * 解析一段 md 并回写到 PMRS。设置 isImporting 标志以跳过反向同步。
 * @param md 文件全文
 */
export async function importL2Markdown(md: string): Promise<ImportResult> {
  const { id, content } = parseL2Markdown(md);
  if (!id) return { id: null, ok: false, reason: "no-frontmatter-id", changed: false };
  if (content === null) return { id, ok: false, reason: "no-content", changed: false };

  setImportingMemory(true);
  try {
    const before = await memoryStore.getAllL2();
    const existing = before.find((m: L2Memory) => m.id === id);
    if (!existing) {
      return { id, ok: false, reason: "not-found", changed: false };
    }
    if (existing.content === content) {
      return { id, ok: true, changed: false }; // 内容未变，不写
    }
    await memoryStore.updateL2Content(id, content);
    return { id, ok: true, changed: true };
  } finally {
    setImportingMemory(false);
  }
}

/** 读取单个 vault md 文件并回流。文件不存在（被删除）时静默跳过。 */
export async function importL2File(filePath: string): Promise<ImportResult> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { id: null, ok: false, reason: "deleted", changed: false };
  }
  return importL2Markdown(raw);
}

// ── 监听器 ──

let watcher: fs.FSWatcher | null = null;
let watchedVaultPath: string | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingFiles = new Set<string>();

function scheduleProcess(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void processPending().catch((err) => {
      logger.warn(
        LogTag.Cyrene,
        `[obsidian-import] process failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, IMPORT_DEBOUNCE_MS);
}

async function processPending(): Promise<void> {
  if (!watchedVaultPath) return;
  const files = Array.from(pendingFiles);
  pendingFiles.clear();
  if (files.length === 0) return;

  const l2Dir = path.join(watchedVaultPath, L2_DIR);
  let changedCount = 0;
  // 标志由 importL2Markdown 单点管理（每个文件回写期间 set true，结束后 set false）
  for (const fname of files) {
    const result = await importL2File(path.join(l2Dir, fname));
    if (result.changed) changedCount++;
  }
  if (changedCount > 0) {
    logger.info(LogTag.Cyrene, `[obsidian-import] imported ${changedCount} changed memory(ies) from vault`);
  }
}

/** 启动 vault 监听（绑定时调用）。重复绑定同路径幂等。 */
export function startVaultWatcher(vaultPath: string): void {
  if (!vaultPath) return;
  if (watcher && watchedVaultPath === vaultPath) return; // 已在监听同一路径
  stopVaultWatcher();

  const l2Dir = path.join(vaultPath, L2_DIR);
  if (!fs.existsSync(l2Dir)) {
    try {
      fs.mkdirSync(l2Dir, { recursive: true });
    } catch {
      // 创建失败也尝试 watch，由 fs.watch 自己抛错
    }
  }

  watchedVaultPath = vaultPath;
  // Windows 下 os.tmpdir() 可能返回 8.3 短路径，而 fs.watch 事件回调里报告的是长路径，
  // 两者前缀不一致会触发 libuv 断言。使用 realpath 获取规范化长路径。
  const resolvedL2Dir = fs.realpathSync.native(l2Dir);
  try {
    watcher = fs.watch(resolvedL2Dir, { recursive: false, persistent: false }, (_eventType, filename) => {
      if (!filename || !filename.endsWith(".md")) return;
      pendingFiles.add(filename);
      scheduleProcess();
    });
    watcher.on("error", (err) => {
      logger.warn(
        LogTag.Cyrene,
        `[obsidian-import] watcher error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    logger.info(LogTag.Cyrene, `[obsidian-import] watcher started on ${l2Dir}`);
  } catch (err) {
    logger.warn(
      LogTag.Cyrene,
      `[obsidian-import] fs.watch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    watcher = null;
    watchedVaultPath = null;
  }
}

/** 停止监听（解绑时调用）。 */
export function stopVaultWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // 忽略
    }
    watcher = null;
  }
  pendingFiles.clear();
  if (watchedVaultPath) {
    logger.info(LogTag.Cyrene, `[obsidian-import] watcher stopped`);
    watchedVaultPath = null;
  }
}

export function isVaultWatcherActive(): boolean {
  return watcher !== null;
}

export function getWatchedVaultPath(): string | null {
  return watchedVaultPath;
}

// 确保在测试间能重置内部状态
export function _resetForTest(): void {
  stopVaultWatcher();
  setImportingMemory(false);
}
