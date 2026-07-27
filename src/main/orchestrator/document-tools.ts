// 文檔生成工具 —— 讓昔漣能產出可交付物（Excel/Word/PDF/Markdown）。
//
// 設計要點：
// - 所有文檔默認存到桌面（app.getPath("desktop")），用戶最容易找到
// - 支持桌面子目錄（如 "test/report.xlsx"），自動創建父目錄
// - 文件名由模型給，強制校驗擴展名（防 .exe 等危險後綴）
// - 返回完整路徑給模型，模型可以轉述給用戶
// - PDF 中文字體走系統微軟雅黑（Windows），找不到就降級

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { toolRegistry } from "./tool-registry";

const LOG_PREFIX = "[DocTools]";

/** 校驗文件名：必須有合法擴展名，不能有危險字符。 */
function validateFilename(filename: string, ext: string): string | null {
  if (!filename || typeof filename !== "string") return null;
  if (!filename.toLowerCase().endsWith(ext)) return null;
  // 防危險字符
  if (/[<>:"|?*]/.test(filename)) return null;
  return filename;
}

/**
 * 解析輸出路徑：filename 可含子目錄（如 "test/report.xlsx"），根始終是桌面。
 * 安全校驗：禁止 .. 穿越、禁止絕對路徑（不能寫到桌面之外）。
 * 返回絕對路徑，或 null 表示校驗失敗。
 */
function resolveOutputPath(filename: string): string | null {
  const normalized = path.normalize(filename).replace(/\\/g, "/");
  // 禁止目錄穿越和絕對路徑
  if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
  const desktop = app.getPath("desktop");
  const fullPath = path.join(desktop, normalized);
  // 最終校驗：解析後必須仍在桌面下
  if (!fullPath.startsWith(desktop)) return null;
  return fullPath;
}

/** 桌面路徑（舊接口，保持兼容）。 */
function desktopPath(filename: string): string {
  return path.join(app.getPath("desktop"), filename);
}

// ── 樣式加載器（Excel + Word 共用）──
// 從 skills/{skillId}/styles/ 目錄加載 json 風格文件，帶緩存。
interface StyleCacheEntry { [styleId: string]: Record<string, unknown> }
const styleCache = new Map<string, StyleCacheEntry>();
const styleLoaded = new Set<string>();

function loadStylesDir(skillId: string): StyleCacheEntry {
  if (styleLoaded.has(skillId)) return styleCache.get(skillId) ?? {};
  styleLoaded.add(skillId);
  const cache: StyleCacheEntry = {};
  try {
    const candidates = [
      path.join(app.getAppPath(), "skills", skillId, "styles"),
      path.join(process.cwd(), "skills", skillId, "styles"),
    ];
    let stylesDir = "";
    for (const c of candidates) {
      if (fs.existsSync(c)) { stylesDir = c; break; }
    }
    if (!stylesDir) return {};

    for (const f of fs.readdirSync(stylesDir)) {
      if (!f.endsWith(".json")) continue;
      const styleId = f.replace(/\.json$/, "");
      try {
        cache[styleId] = JSON.parse(fs.readFileSync(path.join(stylesDir, f), "utf8"));
      } catch { /* 跳過壞文件 */ }
    }
    console.log(LOG_PREFIX, `已加載 ${skillId} 樣式:`, Object.keys(cache).join(", ") || "(無)");
  } catch { /* 目錄不存在 */ }
  styleCache.set(skillId, cache);
  return cache;
}

/** 把 hex 顏色轉成 ARGB（FF 前綴），docx 庫用 6 位 RRGGBB 不帶 FF 前綴。 */
function toHexColor(color: string): string {
  const c = color.replace("#", "").toUpperCase();
  if (c.length === 8) return c.slice(2);  // FFRRGGBB → RRGGBB
  if (c.length === 6) return c;
  return "1F4E79"; // 兜底
}

export function registerDocumentTools(): void {
  // ── 樣式系統 ──
  // 從 skills/xlsx/styles/ 目錄加載預設風格 json，取代硬編碼。
  // 模型彈卡片前讀 catalog.md 選風格，用戶選完傳 style 名給 write_excel。
  type ExcelFill = import("exceljs").Fill;
  type ExcelBorders = import("exceljs").Borders;

  interface Theme {
    name: string;
    headerFill: string;      // ARGB
    headerFont: string;     // ARGB
    headerBorder: string;   // ARGB (medium bottom)
    zebraFill: string;      // ARGB
    borderColor: string;    // ARGB
  }

  /** 從 skills/xlsx/styles/ 加載所有風格 json（帶緩存）。 */
  const themeCache = new Map<string, Theme>();
  let themesLoaded = false;

  const DEFAULT_THEME: Theme = {
    name: "默認深藍", headerFill: "FF1F4E79", headerFont: "FFFFFFFF",
    headerBorder: "FF1F4E79", zebraFill: "FFF2F2F2", borderColor: "FFBFBFBF",
  };

  function loadThemes(): void {
    if (themesLoaded) return;
    themesLoaded = true;
    try {
      // 嘗試多個可能的 skill 路徑
      const candidates = [
        path.join(app.getAppPath(), "skills", "xlsx", "styles"),
        path.join(process.cwd(), "skills", "xlsx", "styles"),
      ];
      let stylesDir = "";
      for (const c of candidates) {
        if (fs.existsSync(c)) { stylesDir = c; break; }
      }
      if (!stylesDir) return;

      for (const f of fs.readdirSync(stylesDir)) {
        if (!f.endsWith(".json")) continue;
        const styleId = f.replace(/\.json$/, "");
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(stylesDir, f), "utf8"));
          themeCache.set(styleId, {
            name: String(raw.name || styleId),
            headerFill: String(raw.headerFill || DEFAULT_THEME.headerFill),
            headerFont: String(raw.headerFont || DEFAULT_THEME.headerFont),
            headerBorder: String(raw.headerBorder || DEFAULT_THEME.headerBorder),
            zebraFill: String(raw.zebraFill || DEFAULT_THEME.zebraFill),
            borderColor: String(raw.borderColor || DEFAULT_THEME.borderColor),
          });
        } catch { /* 跳過壞文件 */ }
      }
      console.log(LOG_PREFIX, "已加載樣式:", Array.from(themeCache.keys()).join(", ") || "(無)");
    } catch {
      // 目錄不存在，用默認主題
    }
  }

  function getTheme(style?: string): Theme {
    loadThemes();
    if (!style) return themeCache.get("default") ?? DEFAULT_THEME;
    return themeCache.get(style) ?? themeCache.get("default") ?? DEFAULT_THEME;
  }

  /** 把 hex 顏色 (#RRGGBB 或 RRGGBB) 轉成 ARGB (FFRRGGBB)，已含 FF 前綴則原樣返回。 */
  function toArgb(color: string): string {
    const c = color.replace("#", "").toUpperCase();
    if (c.length === 8) return c;
    if (c.length === 6) return "FF" + c;
    return "FF1F4E79"; // 兜底
  }

  /**
   * 用自定義顏色覆蓋主題。colors 裡每個字段是可選的 ARGB hex 值。
   * 模型能把用戶自然語言（"粉色""深灰"）翻譯成 hex 後傳進來。
   */
  function mergeTheme(base: Theme, colors?: {
    headerFill?: string; headerFont?: string; headerBorder?: string;
    zebraFill?: string; borderColor?: string;
  }): Theme {
    if (!colors) return base;
    return {
      name: base.name + "(自定義)",
      headerFill: colors.headerFill ? toArgb(colors.headerFill) : base.headerFill,
      headerFont: colors.headerFont ? toArgb(colors.headerFont) : base.headerFont,
      headerBorder: colors.headerBorder ? toArgb(colors.headerBorder) : base.headerBorder,
      zebraFill: colors.zebraFill ? toArgb(colors.zebraFill) : base.zebraFill,
      borderColor: colors.borderColor ? toArgb(colors.borderColor) : base.borderColor,
    };
  }

  // ── write_excel ──────────────────────────────────────
  toolRegistry.register({
    id: "write_excel",
    name: "寫 Excel",
    description:
      "生成一個美觀的 Excel 文件（.xlsx）。支持多種預設風格 + 自定義顏色。已內置：表頭加粗+背景、" +
      "全表細邊框、隔行斑馬紋、列寬自適應、數字右對齊+千位分隔、凍結首行、自動篩選。\n" +
      "【優先使用】簡單表格生成、數據整理、換算結果導出等場景應直接用此工具，不要走 invoke_skill(xlsx)。\n\n" +
      "何時用：\n" +
      "- 用戶要把數據整理成表格\n" +
      "- 用戶要「做一張表」「導出 Excel」「整理成 Excel」\n" +
      "- 用戶通過 ask_user_choice 選擇了風格 → 用對應 style 參數直接生成\n" +
      "- 用戶給了自定義顏色要求 → 用 colors 參數傳 ARGB hex 值\n\n" +
      "不要用於：\n" +
      "- 需要 Excel 公式、編輯已有 xlsx → 才考慮 invoke_skill(xlsx)\n\n" +
      "style：預設風格名（見 skills/xlsx/styles/catalog.md）。可選值含 default / dark / colorful / simple-business / financial。\n" +
      "colors（可選）：自定義顏色覆蓋，每個是 ARGB hex 如 'FFF8BBD0'（粉色）。\n" +
      "參數：filename（.xlsx 結尾，可含子目錄），sheets（工作表數組），style（可選），colors（可選）。",
    enabled: true,
    risk: "fs-write",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "文件名，可含子目錄如 'test/report.xlsx'（相對桌面，.xlsx 結尾）" },
        sheets: {
          type: "array",
          description: "工作表數組",
          items: {
            type: "object",
            properties: {
              name:    { type: "string", description: "工作表名" },
              headers: { type: "array", description: "表頭字符串數組", items: { type: "string" } },
              rows:    { type: "array", description: "數據行，每行是一個數組", items: { type: "string" } },
            },
          },
        },
        style: { type: "string", description: "預設主題：default(深藍,默認) / simple-business(簡潔商務) / dark(深色護眼) / colorful(彩色清晰) / financial(財務報表)" },
        colors: {
          type: "object",
          description: "自定義顏色覆蓋（ARGB hex，如 'FFF8BBD0' 粉色 / 'FF2D2D2D' 深灰）。你負責把用戶的顏色描述翻譯成 hex。",
          properties: {
            headerFill: { type: "string", description: "表頭背景色 ARGB hex，如 'FFF8BBD0'(粉)" },
            headerFont: { type: "string", description: "表頭文字色 ARGB hex，如 'FF333333'(深灰)" },
            headerBorder: { type: "string", description: "表頭底線色 ARGB hex" },
            zebraFill: { type: "string", description: "斑馬紋背景色 ARGB hex" },
            borderColor: { type: "string", description: "邊框顏色 ARGB hex" },
          },
        },
      },
      required: ["filename", "sheets"],
    },
    execute: async (args) => {
      const filename = validateFilename(String(args.filename || ""), ".xlsx");
      if (!filename) return "[錯誤] filename 必須是 .xlsx 結尾";
      const outputPath = resolveOutputPath(filename);
      if (!outputPath) return "[錯誤] 路徑不合法（禁止目錄穿越或絕對路徑）: " + filename;
      const sheets = args.sheets as Array<{
        name: string; headers: string[]; rows: unknown[][];
      }>;
      if (!Array.isArray(sheets) || sheets.length === 0) {
        return "[錯誤] sheets 不能為空";
      }

      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();

      // 選主題（預設 + 自定義顏色覆蓋）
      const baseTheme = getTheme(args.style ? String(args.style) : undefined);
      const colors = args.colors as {
        headerFill?: string; headerFont?: string; headerBorder?: string;
        zebraFill?: string; borderColor?: string;
      } | undefined;
      const theme = mergeTheme(baseTheme, colors);
      console.log(LOG_PREFIX, "Excel 主題:", theme.name, "style=" + (args.style || "default"), colors ? "+自定義顏色" : "");

      const HEADER_FILL: ExcelFill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.headerFill } };
      const ZEBRA_FILL: ExcelFill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.zebraFill } };
      const THIN_BORDER: Partial<ExcelBorders> = {
        top: { style: "thin", color: { argb: theme.borderColor } },
        left: { style: "thin", color: { argb: theme.borderColor } },
        bottom: { style: "thin", color: { argb: theme.borderColor } },
        right: { style: "thin", color: { argb: theme.borderColor } },
      };
      const HEADER_BOTTOM_BORDER: Partial<ExcelBorders> = {
        ...THIN_BORDER,
        bottom: { style: "medium", color: { argb: theme.headerBorder } },
      };

      for (const s of sheets) {
        const ws = workbook.addWorksheet(s.name || "Sheet1");

        // 寫入數據
        if (Array.isArray(s.headers)) ws.addRow(s.headers);
        for (const row of (s.rows || [])) ws.addRow(row);

        const headers = s.headers || [];
        const dataRowCount = (s.rows?.length || 0);
        const totalRows = dataRowCount + 1; // +1 for header

        // 1. 表頭樣式：白粗體字 + 深藍填充 + 居中 + 底部粗線
        // 逐 cell 設置（行級 fill/font/alignment 會鋪到無值的空列，導致表頭藍條超出實際列數）
        const headerRow = ws.getRow(1);
        headerRow.height = 24;
        headerRow.eachCell({ includeEmpty: false }, (cell) => {
          cell.font = { bold: true, color: { argb: theme.headerFont }, size: 11, name: "Calibri" };
          cell.fill = HEADER_FILL;
          cell.alignment = { horizontal: "center", vertical: "middle" };
          cell.border = HEADER_BOTTOM_BORDER;
        });

        // 2. 數據行：全表細邊框 + 智能數字格式 + 斑馬紋
        for (let r = 2; r <= totalRows; r++) {
          const row = ws.getRow(r);
          // 斑馬紋（偶數數據行 = Excel 標準交替灰）
          const isZebra = (r - 1) % 2 === 0;
          row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            cell.border = THIN_BORDER;
            // 斑馬紋需逐 cell 設（行級 fill 會被 eachCell 的 cell 對象覆蓋）
            if (isZebra) {
              cell.fill = ZEBRA_FILL;
            }
            // 智能數字格式（參考 minimax skill format.md 的格式矩陣）
            if (typeof cell.value === "number") {
              cell.alignment = { horizontal: "right", vertical: "middle" };
              // 按列內容推斷數字格式
              const headerText = headers[colNumber - 1] ? String(headers[colNumber - 1]).toLowerCase() : "";
              if (/年|year/.test(headerText)) {
                cell.numFmt = "0";              // 年份：無千位分隔（2024 不是 2,024）
              } else if (/%|率|比|ratio|rate|漲|跌|幅/.test(headerText)) {
                cell.numFmt = "0.0%";           // 百分比
              } else if (/\$|元|價|額|金|amount|price|cost|revenue/.test(headerText)) {
                cell.numFmt = "#,##0.00";      // 貨幣：帶分
              } else if (Number.isInteger(cell.value) && Math.abs(cell.value) >= 1000) {
                cell.numFmt = "#,##0";          // 大整數：千位分隔無小數
              } else {
                cell.numFmt = "#,##0.00";       // 默認數字
              }
            } else if (cell.value instanceof Date) {
              cell.alignment = { horizontal: "center", vertical: "middle" };
              cell.numFmt = "yyyy-mm-dd";
            } else {
              cell.alignment = { horizontal: "left", vertical: "middle" };
            }
          });
        }

        // 3. 列寬自適應：按表頭 + 數據行中最大寬度計算（中文按 2 寬度估算）
        ws.columns.forEach((col, i) => {
          let maxLen = headers[i] ? Array.from(String(headers[i])).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 2 : 1), 0) + 4 : 8;
          for (const row of (s.rows || [])) {
            const val = row[i];
            if (val !== undefined && val !== null) {
              const len = Array.from(String(val)).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
              if (len + 2 > maxLen) maxLen = len + 2;
            }
          }
          col.width = Math.min(Math.max(maxLen, 10), 45);
        });

        // 4. 凍結首行
        ws.views = [{ state: "frozen", ySplit: 1 }];

        // 5. 自動篩選：表頭行加 filter（方便用戶篩選排序）
        if (headers.length > 0 && dataRowCount > 0) {
          ws.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: totalRows, column: headers.length },
          };
        }
      }

      // 自動創建父目錄（支持子目錄寫入）
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      await workbook.xlsx.writeFile(outputPath);
      console.log(LOG_PREFIX, "Excel 已生成（默認美觀樣式）:", outputPath);
      return `[write_excel] 已生成：${outputPath}`;
    },
  });

  // ── write_word ───────────────────────────────────────
  toolRegistry.register({
    id: "write_word",
    name: "寫 Word",
    description:
      "生成一個美觀的 Word 文檔（.docx）。支持多種預設風格主題。\n" +
      "已內置：標題樣式（顏色/字號/字體）、正文行距/字體/顏色、段落間距。\n\n" +
      "何時用：\n" +
      "- 用戶要寫報告/總結/方案/請假條\n" +
      "- 需要「導出成 Word」「做成 docx」\n" +
      "- 用戶通過 ask_user_choice 選擇了風格 → 用對應 style 參數直接生成\n\n" +
      "不要用於：\n" +
      "- 表格數據（用 write_excel）\n" +
      "- 輕量筆記（用 write_markdown）\n" +
      "- 需要複雜排版（頁眉頁腳/目錄/圖片/表格）→ 才考慮 invoke_skill(docx)\n\n" +
      "style 可選值（見 skills/docx/styles/catalog.md）：default(商務) / academic(學術) / clean(極簡) / elegant(優雅) / formal(公文)。\n" +
      "參數：filename（.docx 結尾，可含子目錄），title（標題），paragraphs（段落數組），style（可選預設風格）。",
    enabled: true,
    risk: "fs-write",
    inputSchema: {
      type: "object",
      properties: {
        filename:   { type: "string", description: "文件名，可含子目錄如 'test/report.docx'（.docx 結尾）" },
        title:      { type: "string", description: "文檔標題" },
        paragraphs: { type: "array", description: "段落字符串數組", items: { type: "string" } },
        style:      { type: "string", description: "預設風格：default(商務) / academic(學術) / clean(極簡) / elegant(優雅) / formal(公文)" },
      },
      required: ["filename", "title", "paragraphs"],
    },
    execute: async (args) => {
      const filename = validateFilename(String(args.filename || ""), ".docx");
      if (!filename) return "[錯誤] filename 必須是 .docx 結尾";
      const outputPath = resolveOutputPath(filename);
      if (!outputPath) return "[錯誤] 路徑不合法（禁止目錄穿越或絕對路徑）: " + filename;

      // 加載風格
      const styles = loadStylesDir("docx");
      const styleId = args.style ? String(args.style) : "default";
      const theme = (styles[styleId] ?? styles["default"]) as {
        name?: string; titleColor?: string; titleSize?: number; titleFont?: string;
        bodyFont?: string; bodySize?: number; bodyColor?: string; lineSpacing?: number; headingColor?: string;
      } | undefined;

      const titleColor = toHexColor(theme?.titleColor ?? "FF1F4E79");
      const titleSize = theme?.titleSize ?? 28;
      const titleFont = theme?.titleFont ?? "微軟雅黑";
      const bodyFont = theme?.bodyFont ?? "微軟雅黑";
      const bodySize = theme?.bodySize ?? 24;
      const bodyColor = toHexColor(theme?.bodyColor ?? "FF333333");
      const lineSpacing = theme?.lineSpacing ?? 360;
      const headingColor = toHexColor(theme?.headingColor ?? "FF1F4E79");

      console.log(LOG_PREFIX, "Word 主題:", theme?.name ?? "默認商務", "style=" + styleId);

      const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
      const doc = new Document({
        styles: {
          default: {
            document: {
              run: { font: bodyFont, size: bodySize, color: bodyColor },
              paragraph: { spacing: { line: lineSpacing } },
            },
          },
        },
        sections: [{
          children: [
            new Paragraph({
              text: String(args.title || ""),
              heading: HeadingLevel.HEADING_1,
              run: { font: titleFont, size: titleSize, bold: true, color: titleColor },
              spacing: { after: 200, line: lineSpacing },
            }),
            ...((args.paragraphs as string[]) || []).map(p =>
              new Paragraph({
                children: [new TextRun({ text: p, font: bodyFont, size: bodySize, color: bodyColor })],
                spacing: { line: lineSpacing, after: 120 },
              })
            ),
          ],
        }],
      });

      const buffer = await Packer.toBuffer(doc);
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, buffer);
      console.log(LOG_PREFIX, "Word 已生成:", outputPath);
      return `[write_word] 已生成：${outputPath}`;
    },
  });

  // ── write_pdf ────────────────────────────────────────
  toolRegistry.register({
    id: "write_pdf",
    name: "寫 PDF",
    description:
      "生成一個 PDF 文件保存到桌面。\n\n" +
      "何時用：\n" +
      "- 用戶要寫正式文檔（合同/簡歷/申請書）\n" +
      "- 需要「導出成 PDF」\n\n" +
      "不要用於：\n" +
      "- 可編輯文檔（用 write_word）\n" +
      "- 表格數據（用 write_excel）\n\n" +
      "參數：filename（.pdf 結尾），title（標題），paragraphs（段落數組）。",
    enabled: true,
    risk: "fs-write",
    inputSchema: {
      type: "object",
      properties: {
        filename:   { type: "string", description: "文件名（.pdf 結尾）" },
        title:      { type: "string", description: "標題" },
        paragraphs: { type: "array", description: "段落字符串數組", items: { type: "string" } },
      },
      required: ["filename", "title", "paragraphs"],
    },
    execute: async (args) => {
      const filename = validateFilename(String(args.filename || ""), ".pdf");
      if (!filename) return "[錯誤] filename 必須是 .pdf 結尾";
      const outputPath = resolveOutputPath(filename);
      if (!outputPath) return "[錯誤] 路徑不合法（禁止目錄穿越或絕對路徑）: " + filename;

      const PDFKit = await import("pdfkit");
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const doc = new PDFKit.default();
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      // 中文字體：Windows 用微軟雅黑，找不到則用默認（中文會亂碼但能生成）
      const fontCandidates = [
        "C:\\Windows\\Fonts\\msyh.ttc",
        "C:\\Windows\\Fonts\\simsun.ttc",
        "C:\\Windows\\Fonts\\simhei.ttf",
      ];
      for (const f of fontCandidates) {
        if (fs.existsSync(f)) { doc.font(f); break; }
      }

      doc.fontSize(22).text(String(args.title || ""), { align: "center" });
      doc.moveDown();
      doc.fontSize(12);
      for (const p of (args.paragraphs as string[]) || []) {
        doc.text(p, { align: "left" });
        doc.moveDown(0.5);
      }
      doc.end();

      await new Promise<void>((resolve, reject) => {
        stream.on("finish", () => resolve());
        stream.on("error", reject);
      });
      console.log(LOG_PREFIX, "PDF 已生成:", outputPath);
      return `[write_pdf] 已生成：${outputPath}`;
    },
  });

  // ── write_markdown ───────────────────────────────────
  toolRegistry.register({
    id: "write_markdown",
    name: "寫 Markdown",
    description:
      "生成一個 Markdown 文件（.md）保存到桌面。\n\n" +
      "何時用：\n" +
      "- 用戶要寫筆記/文檔\n" +
      "- 需要輕量級文檔輸出\n" +
      "- 比 Word/PDF 更輕量的場景\n\n" +
      "不要用於：\n" +
      "- 正式文檔（用 write_word / write_pdf）\n" +
      "- 表格數據（用 write_excel）\n\n" +
      "參數：filename（.md 結尾），content（markdown 內容字符串）。",
    enabled: true,
    risk: "fs-write",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "文件名（.md 結尾）" },
        content:  { type: "string", description: "markdown 內容" },
      },
      required: ["filename", "content"],
    },
    execute: async (args) => {
      const filename = validateFilename(String(args.filename || ""), ".md");
      if (!filename) return "[錯誤] filename 必須是 .md 結尾";
      const outputPath = resolveOutputPath(filename);
      if (!outputPath) return "[錯誤] 路徑不合法（禁止目錄穿越或絕對路徑）: " + filename;

      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, String(args.content || ""), "utf8");
      console.log(LOG_PREFIX, "Markdown 已生成:", outputPath);
      return `[write_markdown] 已生成：${outputPath}`;
    },
  });
}
