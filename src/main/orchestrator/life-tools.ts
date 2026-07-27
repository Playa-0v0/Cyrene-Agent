// 生活類工具 —— 記賬/匯率/翻譯/代碼補丁。
//
// 設計原則：
// - 每個工具職責單一（鐵律 1）
// - 描述寫清 use case / anti-use case（鐵律 2）
// - 記賬走本地 JSON 存儲，不依賴外部服務
// - 匯率走免費無 key 的 frankfurter.app
// - 翻譯複用主模型（質量穩，不增加依賴）
// - apply_patch 做精確字符串替換，要求 old_string 唯一

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { toolRegistry } from "./tool-registry";

const LOG_PREFIX = "[LifeTools]";

// ══════════════════════════════════════════════════════════
// 記賬
// ══════════════════════════════════════════════════════════

interface ExpenseRecord {
  ts: number;
  amount: number;
  category: string;
  note: string;
}

function expenseFile(): string {
  return path.join(app.getPath("userData"), "expenses.json");
}

function loadExpenses(): ExpenseRecord[] {
  try {
    return JSON.parse(fs.readFileSync(expenseFile(), "utf8"));
  } catch {
    return [];
  }
}

function saveExpenses(records: ExpenseRecord[]): void {
  fs.writeFileSync(expenseFile(), JSON.stringify(records, null, 2), "utf8");
}

function registerExpenseTools(): void {
  toolRegistry.register({
    id: "record_expense",
    name: "記賬",
    description:
      "記錄一筆支出。\n\n" +
      "何時用：\n" +
      "- 用戶說「花了 X 元買 Y」「記一下支出」「記賬」\n" +
      "- 用戶提到具體金額和用途\n\n" +
      "不要用於：\n" +
      "- 查賬（用 query_expense）\n" +
      "- 收入記錄（暫不支持）\n\n" +
      "參數：amount（金額，數字），category（分類：餐飲/交通/購物/娛樂/生活/其他），note（備註）。",
    enabled: true,
    risk: "safe",
    inputSchema: {
      type: "object",
      properties: {
        amount:   { type: "number", description: "金額（元）" },
        category: { type: "string", description: "分類：餐飲/交通/購物/娛樂/生活/其他" },
        note:     { type: "string", description: "備註" },
      },
      required: ["amount"],
    },
    execute: async (args) => {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return "[錯誤] amount 必須是正數";
      }
      const records = loadExpenses();
      const rec: ExpenseRecord = {
        ts: Date.now(),
        amount,
        category: String(args.category || "其他"),
        note: String(args.note || ""),
      };
      records.push(rec);
      saveExpenses(records);
      console.log(LOG_PREFIX, "記賬:", rec);
      return `[record_expense] 已記錄：${amount} 元 / ${rec.category} / ${rec.note}`;
    },
  });

  toolRegistry.register({
    id: "query_expense",
    name: "查賬",
    description:
      "查詢支出記錄。\n\n" +
      "何時用：\n" +
      "- 用戶問「這個月花了多少」「最近記賬」「支出明細」\n" +
      "- 用戶想看支出彙總\n\n" +
      "不要用於：\n" +
      "- 記新的一筆（用 record_expense）\n\n" +
      "參數：days（最近 N 天，默認 30），category（可選，按分類過濾），summary（可選，true 只返回彙總）。",
    enabled: true,
    risk: "safe",
    inputSchema: {
      type: "object",
      properties: {
        days:     { type: "number", description: "最近 N 天，默認 30" },
        category: { type: "string", description: "可選，按分類過濾" },
        summary:  { type: "boolean", description: "可選，true 只返回彙總" },
      },
    },
    execute: async (args) => {
      const days = Number(args.days) || 30;
      const cutoff = Date.now() - days * 86400_000;
      let records = loadExpenses().filter(r => r.ts >= cutoff);
      if (args.category) {
        records = records.filter(r => r.category === args.category);
      }
      if (records.length === 0) {
        return `[query_expense] 最近 ${days} 天沒有記賬記錄`;
      }
      if (args.summary) {
        const total = records.reduce((s, r) => s + r.amount, 0);
        const byCat: Record<string, number> = {};
        for (const r of records) {
          byCat[r.category] = (byCat[r.category] || 0) + r.amount;
        }
        return `[query_expense] 最近 ${days} 天共 ${records.length} 筆，合計 ${total.toFixed(2)} 元\n分類：${JSON.stringify(byCat)}`;
      }
      const lines = records.map(r => {
        const d = new Date(r.ts).toLocaleDateString("zh-CN");
        return `${d} ${r.amount}元 ${r.category} ${r.note}`;
      });
      return `[query_expense] 最近 ${days} 天 ${records.length} 筆：\n${lines.join("\n")}`;
    },
  });
}

// ══════════════════════════════════════════════════════════
// 匯率
// ══════════════════════════════════════════════════════════

function registerExchangeRateTool(): void {
  toolRegistry.register({
    id: "exchange_rate",
    name: "匯率查詢",
    description:
      "查詢貨幣匯率並換算。\n\n" +
      "何時用：\n" +
      "- 用戶問「X 美元等於多少人民幣」「100 日元換多少人民幣」\n" +
      "- 用戶提到貨幣換算\n\n" +
      "不要用於：\n" +
      "- 加密貨幣（不支持）\n" +
      "- 歷史匯率（只支持最新）\n\n" +
      "參數：from（源貨幣代碼，如 USD/EUR/JPY/CNY），to（目標貨幣），amount（金額，默認 1）。",
    enabled: true,
    risk: "network",
    inputSchema: {
      type: "object",
      properties: {
        from:   { type: "string", description: "源貨幣代碼，如 USD/EUR/JPY/CNY" },
        to:     { type: "string", description: "目標貨幣代碼" },
        amount: { type: "number", description: "金額，默認 1" },
      },
      required: ["from", "to"],
    },
    execute: async (args) => {
      const from = String(args.from || "USD").toUpperCase();
      const to = String(args.to || "CNY").toUpperCase();
      const amount = Number(args.amount) || 1;
      if (from === to) {
        return `[exchange_rate] ${amount} ${from} = ${amount} ${to}（同幣種）`;
      }
      // frankfurter.app 免費、無 key、支持主要貨幣
      const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        return `[錯誤] 匯率查詢失敗：HTTP ${resp.status}`;
      }
      const data = await resp.json() as { rates?: Record<string, number> };
      const rate = data.rates?.[to];
      if (!rate) {
        return `[exchange_rate] 查不到 ${from} → ${to}，可能是不支持的幣種`;
      }
      const result = (amount * rate).toFixed(2);
      return `[exchange_rate] ${amount} ${from} = ${result} ${to}（匯率 ${rate}，更新於 ${new Date().toLocaleDateString("zh-CN")}）`;
    },
  });
}

// ══════════════════════════════════════════════════════════
// 翻譯
// ══════════════════════════════════════════════════════════

// 翻譯需要調主模型，注入由 index.ts 完成
let modelSettingsGetter: (() => { provider: string; baseUrl: string; model: string; apiKey: string } | null) | null = null;

/** index.ts 啟動時注入模型設置讀取器。 */
export function setTranslateConfig(getter: () => { provider: string; baseUrl: string; model: string; apiKey: string } | null): void {
  modelSettingsGetter = getter;
}

function registerTranslateTool(): void {
  toolRegistry.register({
    id: "translate",
    name: "翻譯",
    description:
      "翻譯文本。\n\n" +
      "何時用：\n" +
      "- 用戶說「翻譯 X」「這句話用 Y 語怎麼說」「X 是什麼意思」\n" +
      "- 用戶問外語詞義\n\n" +
      "不要用於：\n" +
      "- 用戶用中文問中文能答的事\n" +
      "- 長文檔翻譯（建議分段）\n\n" +
      "參數：text（要翻譯的文本），to（目標語言，如「英文」「中文」「日文」），from（可選，源語言，默認自動檢測）。",
    enabled: true,
    risk: "network",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要翻譯的文本" },
        to:   { type: "string", description: "目標語言，如「英文」「中文」「日文」" },
        from: { type: "string", description: "可選，源語言，默認自動檢測" },
      },
      required: ["text", "to"],
    },
    execute: async (args) => {
      const text = String(args.text || "");
      const to = String(args.to || "");
      if (!text || !to) return "[錯誤] text 和 to 不能為空";

      const settings = modelSettingsGetter?.();
      if (!settings || !settings.apiKey) {
        return "[錯誤] 未配置模型，翻譯不可用";
      }

      // 動態 import 避免循環依賴
      const { buildVendorUrlByProvider } = await import("./vendors");
      const fromHint = args.from ? `（源語言：${args.from}）` : "（自動檢測源語言）";
      const sysPrompt = `你是翻譯器${fromHint}。把以下文本翻譯成${to}，只輸出譯文，不要任何解釋或額外文字。`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        const resp = await fetch(buildVendorUrlByProvider(settings.provider, settings.baseUrl), {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify({
            model: settings.model,
            messages: [
              { role: "system", content: sysPrompt },
              { role: "user", content: text },
            ],
            max_tokens: 2000,
            stream: false,
          }),
        });
        if (!resp.ok) return `[錯誤] 翻譯失敗：HTTP ${resp.status}`;
        const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
        const result = data.choices?.[0]?.message?.content?.trim() || "";
        if (!result) return "[錯誤] 翻譯返回空";
        return `[translate] ${result}`;
      } catch (e) {
        return "[錯誤] 翻譯失敗：" + (e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

// ══════════════════════════════════════════════════════════
// 代碼補丁
// ══════════════════════════════════════════════════════════

function registerApplyPatchTool(): void {
  toolRegistry.register({
    id: "apply_patch",
    name: "應用代碼補丁",
    description:
      "對文件應用精確的字符串替換。\n\n" +
      "何時用：\n" +
      "- 修改現有文件中的特定代碼片段\n" +
      "- 用戶要「把 X 改成 Y」「把第 N 行的 A 替換成 B」\n\n" +
      "不要用於：\n" +
      "- 整文件重寫（用 write_file）\n" +
      "- 新建文件（用 write_file）\n\n" +
      "參數：file_path（文件路徑），old_string（要替換的原文本，必須精確匹配含縮進），new_string（替換後的文本）。\n" +
      "old_string 必須在文件中唯一；匹配多處會報錯，需要更長的上下文使其唯一。",
    enabled: true,
    risk: "fs-write",
    inputSchema: {
      type: "object",
      properties: {
        file_path:   { type: "string", description: "文件絕對路徑" },
        old_string:  { type: "string", description: "要替換的原文本（必須精確匹配，含縮進）" },
        new_string:  { type: "string", description: "替換後的文本" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    execute: async (args) => {
      const filePath = String(args.file_path || "");
      if (!filePath) return "[錯誤] file_path 不能為空";
      if (!fs.existsSync(filePath)) return `[錯誤] 文件不存在：${filePath}`;

      const content = fs.readFileSync(filePath, "utf8");
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      if (!oldStr) return "[錯誤] old_string 不能為空";

      const count = content.split(oldStr).length - 1;
      if (count === 0) {
        return "[錯誤] old_string 在文件中未找到。請確認內容（包括縮進、換行）是否精確匹配。";
      }
      if (count > 1) {
        return `[錯誤] old_string 在文件中匹配 ${count} 處，需要更長的上下文使其唯一。`;
      }

      const newContent = content.replace(oldStr, newStr);
      fs.writeFileSync(filePath, newContent, "utf8");
      console.log(LOG_PREFIX, "apply_patch:", filePath);
      return `[apply_patch] 已更新 ${filePath}`;
    },
  });
}

/** 註冊全部生活類工具。index.ts startup 調一次。 */
export function registerLifeTools(): void {
  registerExpenseTools();
  registerExchangeRateTool();
  registerTranslateTool();
  registerApplyPatchTool();
  console.log(LOG_PREFIX, "已註冊：record_expense / query_expense / exchange_rate / translate / apply_patch");
}
