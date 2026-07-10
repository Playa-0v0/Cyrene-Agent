import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

// ── Public types ──
export type AttachmentKind = "text" | "indexed" | "empty" | "unsupported" | "image" | "document";

export interface Attachment {
  name: string;
  kind: AttachmentKind;
  filePath?: string;
  mime?: string;
  previewUrl?: string;
  caption?: string;
  status?: "pending" | "done" | "error";
  /** kind="text" 时的小文件内容 */
  text?: string;
  /** kind="indexed" 时的 chunk 数 */
  chunks?: number;
  /** kind="unsupported" 或 indexed 失败时的原因 */
  reason?: string;
}

/** ingestOneFile 的大文件索引回调签名。由调用方（index.ts）注入具体实现（importDocument）。 */
export type ImportFn = (text: string, fileName: string) => Promise<number>;

// ── Thresholds ──
/** 小文件 vs 大文件（→RAG）的分界，字符数。 */
export const SMALL_THRESHOLD = 30_000;

// ── 扩展名路由 ──
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

export const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp",
]);

const UNSUPPORTED_EXTS = new Set([
  ".zip", ".7z", ".rar", ".tar", ".gz",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".class", ".jar", ".pyc",
  ".o", ".a", ".wasm",
]);

export function isTextExt(ext: string): boolean {
  return TEXT_EXTS.has(ext.toLowerCase());
}

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase());
}

export function getMimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".bmp": return "image/bmp";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

export function isUnsupportedExt(ext: string): boolean {
  return UNSUPPORTED_EXTS.has(ext.toLowerCase());
}

export function isDocumentExt(ext: string): boolean {
  const normalized = ext.toLowerCase();
  return normalized === "" || isTextExt(normalized);
}

export function describePendingAttachment(filePath: string): Attachment {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  if (isImageExt(ext)) {
    return {
      name,
      kind: "image",
      filePath,
      mime: getMimeFromExt(ext),
      previewUrl: pathToFileURL(filePath).toString(),
      status: "pending",
    };
  }
  if (isDocumentExt(ext)) {
    return {
      name,
      kind: "document",
      filePath,
      status: "pending",
    };
  }
  return {
    name,
    kind: "unsupported",
    filePath,
    status: "error",
    reason: `暂不支持的文件格式 ${ext || "（无扩展名）"}`,
  };
}

/**
 * 判二进制：读前 8KB 中有无 null 字节。
 * 不要求读满，如果文件小于 8KB 就全读完。
 */
const BINARY_SCAN_BYTES = 8192;

export function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ── 核心路由：处理单个文件 ──

/**
 * 摄入一个文件。
 * @param filePath 绝对路径
 * @param importFn 大文件时调用的导入函数（通常为 importDocument）
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

  // 显式不支持的类型
  if (isUnsupportedExt(ext)) {
    return { name, kind: "unsupported", reason: `暂不支持的文件格式 ${ext}（MVP-0 仅支持文本）` };
  }

  // 读取文件
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err: any) {
    return { name, kind: "unsupported", reason: err?.code || String(err) };
  }

  // 类型判断与内容提取
  // 文本扩展名
  if (isTextExt(ext)) {
    // 二进制兜底：标题是文本但实际含 null 字节
    if (isBinary(buf)) {
      return { name, kind: "unsupported", reason: `文件 ${ext} 含二进制数据，暂不支持` };
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

  // 无扩展名或未知扩展名：用 null 字节检测
  if (isBinary(buf)) {
    return { name, kind: "unsupported", reason: "二进制文件，暂不支持" };
  }
  // 无扩展名的文本文件
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

// ── 目录递归 ──

/**
 * 递归遍历目录，返回所有（非隐藏）文件的绝对路径。
 * 遇到无权限等异常时跳过该条目，不抛。
 */
export function walkDir(dirPath: string): string[] {
  const result: string[] = [];
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      // 跳过隐藏文件/目录（. 开头）
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
        // 无权限/已删除 → 跳过
      }
    }
  } catch {
    // 无权限浏览目录 → 跳过
  }
  return result;
}

// ── 批量摄入 ──

/**
 * 批量摄入多条路径（文件或目录）。
 * 目录 → walkDir 展开；重复路径去重（realpath）。
 */
export async function ingestPaths(
  paths: string[],
  importFn: ImportFn,
): Promise<Attachment[]> {
  // 展开目录，同时记录每个文件的"显示名"（相对输入目录的路径）
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
      // 不存在 → 跳过
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
      // symlink broken → 跳过
    }
  }

  const results: Attachment[] = [];
  for (const { absPath, displayName } of unique) {
    const att = await ingestOneFile(absPath, importFn);
    // 用保留相对路径的显示名覆盖 basename
    results.push({ ...att, name: displayName, filePath: absPath });
  }
  return results;
}
