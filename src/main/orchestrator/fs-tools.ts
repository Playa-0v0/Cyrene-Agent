// 文件系統工具組 — 給 agent 裝上"讀文件 / 列目錄 / 寫文件 / 讀圖片"四件武器
// 不繞 run_shell，直接用 fs API。每個工具都有 risk 字段交給權限網關判定。

import * as fs from "fs";
import * as path from "path";
import { toolRegistry } from "./tool-registry";
import { captionImage } from "./vision-captioner";
import type { ToolContext } from "./tool-context";

const LOG_PREFIX = "[FsTools]";

const READ_MAX_BYTES = 256 * 1024;       // 單文件最多讀 256KB
const LIST_MAX_ENTRIES = 200;            // 單次目錄列舉最多 200 項
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 圖片最多 5MB

// 圖片擴展名集合，用於 list_dir 標註 [圖片] 和彙總計數
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);

function ensureAbsolute(p: string): string | null {
  if (!p) return null;
  if (!path.isAbsolute(p)) return null;
  return path.normalize(p);
}

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function humanBytes(n: number): string {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

// ── 工具 1：read_file ─────────────────────────────────────

async function executeReadFile(args: Record<string, unknown>): Promise<string> {
  const raw = String(args.path || "").trim();
  const filePath = ensureAbsolute(raw);
  if (!filePath) return "[錯誤] path 必須是絕對路徑";

  const stat = safeStat(filePath);
  if (!stat) return "[錯誤] 文件不存在或無法訪問: " + filePath;
  if (!stat.isFile()) return "[錯誤] 不是文件（是目錄或其它）: " + filePath;

  const startLine = Math.max(1, Number(args.startLine) || 1);
  const maxLines = Math.max(1, Math.min(2000, Number(args.maxLines) || 500));

  console.log(LOG_PREFIX, "read_file:", filePath, "size=" + humanBytes(stat.size), "lines=" + startLine + "..+" + maxLines);

  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 讀取失敗: " + msg;
  }

  const truncatedSize = buf.length > READ_MAX_BYTES;
  const slice = truncatedSize ? buf.subarray(0, READ_MAX_BYTES) : buf;

  // 二進制啟發：前 4KB 出現大量 \0 → 當作二進制
  const head = slice.subarray(0, Math.min(slice.length, 4096));
  let nullCount = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) nullCount++;
  if (nullCount > head.length * 0.05) {
    return "[錯誤] 這看起來是二進制文件，read_file 只支持文本。如果是圖片，請改用 read_image。\n" +
      "path: " + filePath + "\nsize: " + humanBytes(stat.size);
  }

  const text = slice.toString("utf8");
  const lines = text.split(/\r?\n/);
  const total = lines.length;
  const sliceLines = lines.slice(startLine - 1, startLine - 1 + maxLines);

  const head2 = "path: " + filePath + "\nsize: " + humanBytes(stat.size) +
    "\ntotal_lines: ~" + total + (truncatedSize ? "  [文件已按 256KB 截斷]" : "") +
    "\nshowing: line " + startLine + " ~ " + (startLine + sliceLines.length - 1) + "\n\n";

  // 帶行號方便 agent 後續精確引用
  const numbered = sliceLines.map((line, i) => {
    const ln = startLine + i;
    return String(ln).padStart(5, " ") + " | " + line;
  }).join("\n");

  return head2 + numbered;
}

toolRegistry.register({
  id: "read_file",
  name: "讀取文件",
  description:
    "讀取本地文本文件（小說、筆記、代碼、配置、日誌等）。返回帶行號的文本內容。" +
    "文件超過 256KB 會自動截斷；可用 startLine/maxLines 翻頁。\n\n" +
    "何時用：\n" +
    "- 用戶消息裡出現任何本地文件路徑、文件名、擴展名（.txt/.md/.json/.py/.log 等）\n" +
    "- 用戶問'這個文件寫了什麼''看看 xxx'\n" +
    "- 需要拿文件實際內容才能回答的問題\n\n" +
    "不要用於：\n" +
    "- 憑印象猜內容（絕對不行，必須先 read）\n" +
    "- 讀圖片 → read_image\n" +
    "- 列目錄 → list_dir\n\n" +
    "參數：path (必填，絕對路徑)，startLine (可選，默認 1)，maxLines (可選，默認 500)。",
  enabled: true,
  risk: "fs-read",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "要讀的文件絕對路徑，例如 'C:\\\\Users\\\\me\\\\notes.txt'" },
      startLine: { type: "number", description: "起始行號，默認 1" },
      maxLines: { type: "number", description: "最多讀多少行，默認 500，最大 2000" },
    },
    required: ["path"],
  },
  execute: executeReadFile,
});

// ── 工具 2：list_dir ──────────────────────────────────────

async function executeListDir(args: Record<string, unknown>): Promise<string> {
  const raw = String(args.path || "").trim();
  const dirPath = ensureAbsolute(raw);
  if (!dirPath) return "[錯誤] path 必須是絕對路徑";

  const stat = safeStat(dirPath);
  if (!stat) return "[錯誤] 目錄不存在或無法訪問: " + dirPath;
  if (!stat.isDirectory()) return "[錯誤] 不是目錄: " + dirPath;

  const showHidden = args.showHidden === true;
  const filter = typeof args.filter === "string" ? args.filter.trim() : "";
  console.log(LOG_PREFIX, "list_dir:", dirPath, "showHidden=" + showHidden);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 讀取目錄失敗: " + msg;
  }

  if (!showHidden) {
    entries = entries.filter(e => !e.name.startsWith("."));
  }

  // 文件夾在前，文件在後；同類按名字排序
  entries.sort((a, b) => {
    const da = a.isDirectory() ? 0 : 1;
    const db = b.isDirectory() ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });

  const truncated = entries.length > LIST_MAX_ENTRIES;
  const slice = truncated ? entries.slice(0, LIST_MAX_ENTRIES) : entries;

  // 彙總圖片數量，讓模型不用逐個數就能回答"有幾張圖"
  const imageCount = entries.filter(e => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())).length;

  const lines: string[] = [];
  lines.push("dir: " + dirPath);
  lines.push(
    "count: " + entries.length +
    (imageCount > 0 ? " (其中圖片 " + imageCount + " 張)" : "") +
    (filter ? " (filter: " + filter + ")" : "") +
    (truncated ? " (僅顯示前 " + LIST_MAX_ENTRIES + " 項)" : ""),
  );
  lines.push("");

  for (const ent of slice) {
    const full = path.join(dirPath, ent.name);
    if (ent.isDirectory()) {
      lines.push("[D] " + ent.name + "/");
    } else if (ent.isFile()) {
      const st = safeStat(full);
      const size = st ? "  " + humanBytes(st.size) : "";
      // 標註文件類型，重點讓圖片顯式可見，模型才能數清"有幾張圖"
      const ext = path.extname(ent.name).toLowerCase();
      const tag = IMAGE_EXTS.has(ext) ? "  [圖片]" : "";
      lines.push("[F] " + ent.name + size + tag);
    } else if (ent.isSymbolicLink()) {
      lines.push("[L] " + ent.name);
    } else {
      lines.push("[?] " + ent.name);
    }
  }
  return lines.join("\n");
}

toolRegistry.register({
  id: "list_dir",
  name: "列出目錄",
  description:
    "列出某個目錄下的子目錄和文件。輸出會對圖片文件標註 [圖片]，並在 count 行彙總圖片數量。\n\n" +
    "何時用：\n" +
    "- 用戶問'我那裡有什麼文件''看看 D:/小說 下面''有幾張圖片'\n" +
    "- 用戶提到目錄名但不知道里面有什麼\n" +
    "- 想確認某個文件是否存在於某個目錄\n\n" +
    "不要用於：\n" +
    "- 讀具體文件內容 → read_file\n" +
    "- 用戶給了完整文件路徑 → 直接 read_file\n\n" +
    "參數：path (必填，絕對路徑)，showHidden (可選，是否顯示以 . 開頭的隱藏項，默認 false)。",
  enabled: true,
  risk: "fs-read",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "要列舉的目錄絕對路徑" },
      showHidden: { type: "boolean", description: "是否包含隱藏項（以 . 開頭），默認 false" },
    },
    required: ["path"],
  },
  execute: executeListDir,
});

// ── 工具 3：write_file ────────────────────────────────────

async function executeWriteFile(args: Record<string, unknown>): Promise<string> {
  const raw = String(args.path || "").trim();
  const filePath = ensureAbsolute(raw);
  if (!filePath) return "[錯誤] path 必須是絕對路徑";

  const content = typeof args.content === "string" ? args.content : "";
  const append = args.append === true;
  const createDirs = args.createDirs !== false; // 默認創建父目錄

  console.log(LOG_PREFIX, "write_file:", filePath, "bytes=" + Buffer.byteLength(content, "utf8"), append ? "(append)" : "(overwrite)");

  if (createDirs) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return "[錯誤] 創建父目錄失敗: " + msg;
    }
  }

  try {
    if (append) {
      fs.appendFileSync(filePath, content, "utf8");
    } else {
      fs.writeFileSync(filePath, content, "utf8");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 寫入失敗: " + msg;
  }

  const st = safeStat(filePath);
  return "[OK] 已" + (append ? "追加" : "寫入") + ": " + filePath +
    (st ? "\nsize: " + humanBytes(st.size) : "");
}

toolRegistry.register({
  id: "write_file",
  name: "寫入文件",
  description:
    "把文本內容寫入本地文件，覆蓋或追加。會自動創建父目錄。\n\n" +
    "何時用：\n" +
    "- 用戶要保存生成的筆記、改寫後的文本、配置\n" +
    "- 用戶要新建文件\n" +
    "- 需要持久化一段內容到磁盤\n\n" +
    "不要用於：\n" +
    "- 修改已有文件的局部內容（用 apply_patch 更安全）\n" +
    "- 生成 Excel/Word/PDF/Markdown 文檔（用對應專用工具）\n" +
    "- 寫入危險系統路徑\n\n" +
    "參數：path (絕對路徑)，content (要寫的字符串)，append (可選，true=追加，默認 false=覆蓋)，createDirs (可選，默認 true)。",
  enabled: true,
  risk: "fs-write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "目標文件絕對路徑" },
      content: { type: "string", description: "要寫入的文本內容（UTF-8）" },
      append: { type: "boolean", description: "true=追加，false=覆蓋（默認）" },
      createDirs: { type: "boolean", description: "是否自動創建父目錄，默認 true" },
    },
    required: ["path", "content"],
  },
  execute: executeWriteFile,
});

// ── 工具 4：read_image ────────────────────────────────────
// 資源訪問層：讀圖片→base64→交 vision-captioner 看圖→返回文字。
// 不懂視覺，看圖的活外包給 captioner。

// loadVisionConfig 在 index.ts，但 index.ts 也 import 本文件（副作用註冊），形成循環。
// 用懶加載規避：運行時才 require，此時 index.ts 已初始化完。
function loadVisionConfigLazy() {
  const mod = require("../index") as { loadVisionConfig: () => import("./vision-captioner").VisionConfig | null };
  return mod.loadVisionConfig();
}

async function executeReadImage(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const raw = String(args.path || "").trim();
  const filePath = ensureAbsolute(raw);
  if (!filePath) return "[錯誤] path 必須是絕對路徑";

  const stat = safeStat(filePath);
  if (!stat) return "[錯誤] 文件不存在或無法訪問: " + filePath;
  if (!stat.isFile()) return "[錯誤] 不是文件: " + filePath;
  if (stat.size > IMAGE_MAX_BYTES) {
    return "[錯誤] 圖片過大（>" + humanBytes(IMAGE_MAX_BYTES) + "），當前 " + humanBytes(stat.size);
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
  };
  const mime = mimeMap[ext];
  if (!mime) {
    return "[錯誤] 不支持的圖片格式: " + ext + "（支持 png/jpg/jpeg/gif/webp/bmp/svg）";
  }

  console.log(LOG_PREFIX, "read_image:", filePath, "mime=" + mime, "size=" + humanBytes(stat.size));

  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[錯誤] 讀取失敗: " + msg;
  }

  // 查視覺模型配置（統一判斷入口，不再有調度層門控）
  const visionConfig = loadVisionConfigLazy();
  if (!visionConfig) {
    return "[錯誤·配置] 未啟用視覺能力。請在「設置 → API 設置 → 視覺模型」配置一個 OpenAI 兼容的視覺模型。";
  }

  // 調視覺模型看圖，用戶問題從 ToolContext 來
  const userQuery = ctx?.userQuery ?? "";
  const result = await captionImage(
    { base64: buf.toString("base64"), mime },
    userQuery,
    visionConfig,
  );
  return result;
}

toolRegistry.register({
  id: "read_image",
  name: "讀取圖片",
  description:
    "讀取本地圖片文件，交給視覺模型分析後返回文字描述。支持 png/jpg/jpeg/gif/webp/bmp/svg，最大 5MB。\n\n" +
    "何時用：\n" +
    "- 用戶提到截圖、圖片，想知道內容\n" +
    "- 用戶說'看看這張圖''圖片裡是什麼'\n" +
    "- 環境信息裡說'當前模型支持查看圖片'時\n\n" +
    "不要用於：\n" +
    "- 環境信息說'不支持查看圖片'時（直接告訴用戶看不了，不要調）\n" +
    "- 讀文本文件 → read_file\n" +
    "- 批量讀圖（逐張調用，不要一次性塞多張）\n\n" +
    "若未配置視覺模型會返回錯誤，屆時如實告訴用戶看不了。" +
    "參數：path (必填，絕對路徑)。",
  enabled: true,
  risk: "fs-read",
  needsContext: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "圖片文件絕對路徑" },
    },
    required: ["path"],
  },
  execute: executeReadImage,
});

console.log(LOG_PREFIX, "已註冊：read_file / list_dir / write_file / read_image");
