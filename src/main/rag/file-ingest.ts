import * as fs from "fs";
import * as path from "path";

// ── Public types ──
export type AttachmentKind = "text" | "image" | "indexed" | "empty" | "unsupported";

export interface Attachment {
  name: string;
  kind: AttachmentKind;
  /** kind="text" 時的小文件內容 */
  text?: string;
  /** kind="image" 時只保存本輪選取的路徑，不把圖片內容寫入聊天歷史。 */
  filePath?: string;
  mime?: string;
  /** kind="indexed" 時的 chunk 數 */
  chunks?: number;
  /** kind="unsupported" 或 indexed 失敗時的原因 */
  reason?: string;
}

/** ingestOneFile 的大文件索引回調簽名。由調用方（index.ts）注入具體實現（importDocument）。 */
export type ImportFn = (text: string, fileName: string) => Promise<number>;

// ── Thresholds ──
/** 小文件 vs 大文件（→RAG）的分界，字符數。 */
export const SMALL_THRESHOLD = 30_000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIMES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

// ── 擴展名路由 ──
const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log",
  ".xml", ".yaml", ".yml",
  ".js", ".mjs", ".ts", ".tsx", ".jsx",
  ".py", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
  ".rs", ".go", ".rb", ".php", ".sh", ".bash",
  ".css", ".scss", ".sql",
  ".ini", ".conf", ".toml", ".env",
  ".svg", ".html", ".htm",
]);

const UNSUPPORTED_EXTS = new Set([
  ".zip", ".7z", ".rar", ".tar", ".gz",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".bmp", ".ico",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".class", ".jar", ".pyc",
  ".o", ".a", ".wasm",
]);

export function isTextExt(ext: string): boolean {
  return TEXT_EXTS.has(ext.toLowerCase());
}

export function isUnsupportedExt(ext: string): boolean {
  return UNSUPPORTED_EXTS.has(ext.toLowerCase());
}

/**
 * 判二進制：讀前 8KB 中有無 null 字節。
 * 不要求讀滿，如果文件小於 8KB 就全讀完。
 */
const BINARY_SCAN_BYTES = 8192;

export function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ── 核心路由：處理單個文件 ──

/**
 * 攝入一個文件。
 * @param filePath 絕對路徑
 * @param importFn 大文件時調用的導入函數（通常為 importDocument）
 */
export async function ingestOneFile(
  filePath: string,
  importFn: ImportFn,
): Promise<Attachment> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err: any) {
    return { name: path.basename(filePath), kind: "unsupported", reason: err?.code || String(err) };
  }
  if (!stat.isFile()) {
    return { name: path.basename(filePath), kind: "unsupported", reason: "不是文件" };
  }

  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  const imageMime = IMAGE_MIMES.get(ext);
  if (imageMime) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return { name, kind: "unsupported", reason: "圖片超過 10 MB" };
    }
    return { name, kind: "image", filePath, mime: imageMime };
  }

  // 顯式不支持的類型
  if (isUnsupportedExt(ext)) {
    return { name, kind: "unsupported", reason: `暫不支持的文件格式 ${ext}（MVP-0 僅支持文本）` };
  }

  // 讀取文件
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err: any) {
    return { name, kind: "unsupported", reason: err?.code || String(err) };
  }

  // 類型判斷與內容提取
  // 文本擴展名
  if (isTextExt(ext)) {
    // 二進制兜底：標題是文本但實際含 null 字節
    if (isBinary(buf)) {
      return { name, kind: "unsupported", reason: `文件 ${ext} 含二進制數據，暫不支持` };
    }
    const text = buf.toString("utf-8");
    if (!text.trim()) {
      return { name, kind: "empty" };
    }
    if (text.length > SMALL_THRESHOLD) {
      // 大文本 → 索引到 Vector DB
      try {
        const chunks = await importFn(text, name);
        return { name, kind: "indexed", chunks };
      } catch (err: any) {
        return { name, kind: "indexed", chunks: 0, reason: err?.message || String(err) };
      }
    }
    return { name, kind: "text", text };
  }

  // 無擴展名或未知擴展名：用 null 字節檢測
  if (isBinary(buf)) {
    return { name, kind: "unsupported", reason: "二進制文件，暫不支持" };
  }
  // 無擴展名的文本文件
  const text = buf.toString("utf-8");
  if (!text.trim()) {
    return { name, kind: "empty" };
  }
  if (text.length > SMALL_THRESHOLD) {
    try {
      const chunks = await importFn(text, name);
      return { name, kind: "indexed", chunks };
    } catch (err: any) {
      return { name, kind: "indexed", chunks: 0, reason: err?.message || String(err) };
    }
  }
  return { name, kind: "text", text };
}

// ── 目錄遞歸 ──

/**
 * 遞歸遍歷目錄，返回所有（非隱藏）文件的絕對路徑。
 * 遇到無權限等異常時跳過該條目，不拋。
 */
export function walkDir(dirPath: string): string[] {
  const result: string[] = [];
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      // 跳過隱藏文件/目錄（. 開頭）
      if (item.startsWith(".")) continue;
      const fullPath = path.join(dirPath, item);
      try {
        const s = fs.statSync(fullPath);
        if (s.isDirectory()) {
          result.push(...walkDir(fullPath));
        } else if (s.isFile()) {
          result.push(fullPath);
        }
      } catch {
        // 無權限/已刪除 → 跳過
      }
    }
  } catch {
    // 無權限瀏覽目錄 → 跳過
  }
  return result;
}

// ── 批量攝入 ──

/**
 * 批量攝入多條路徑（文件或目錄）。
 * 目錄 → walkDir 展開；重複路徑去重（realpath）。
 */
export async function ingestPaths(
  paths: string[],
  importFn: ImportFn,
): Promise<Attachment[]> {
  // 展開目錄，同時記錄每個文件的"顯示名"（相對輸入目錄的路徑）
  const filesWithPaths: Array<{ absPath: string; displayName: string }> = [];
  for (const p of paths) {
    try {
      const s = fs.statSync(p);
      if (s.isDirectory()) {
        const children = walkDir(p);
        for (const child of children) {
          filesWithPaths.push({ absPath: child, displayName: path.relative(p, child) });
        }
      } else if (s.isFile()) {
        filesWithPaths.push({ absPath: p, displayName: path.basename(p) });
      }
    } catch {
      // 不存在 → 跳過
    }
  }

  // 去重（用 realpath）
  const seen = new Set<string>();
  const unique: Array<{ absPath: string; displayName: string }> = [];
  for (const entry of filesWithPaths) {
    try {
      const real = fs.realpathSync(entry.absPath);
      if (!seen.has(real)) {
        seen.add(real);
        unique.push({ ...entry, absPath: real });
      }
    } catch {
      // symlink broken → 跳過
    }
  }

  const results: Attachment[] = [];
  for (const { absPath, displayName } of unique) {
    const att = await ingestOneFile(absPath, importFn);
    // 用保留相對路徑的顯示名覆蓋 basename
    results.push({ ...att, name: displayName });
  }
  return results;
}
