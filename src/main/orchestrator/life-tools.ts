// 生活类工具 —— 记账/汇率/翻译/代码补丁。
//
// 设计原则：
// - 每个工具职责单一（铁律 1）
// - 描述写清 use case / anti-use case（铁律 2）
// - 记账走本地 JSON 存储，不依赖外部服务
// - 汇率走免费无 key 的 frankfurter.app
// - 翻译复用主模型（质量稳，不增加依赖）
// - str_replace 做精确字符串替换，要求 old_string 唯一（apply_patch 已改为 Codex 补丁格式，见 apply-patch-tools.ts）

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { toolRegistry } from "./tool-registry";
import { buildReplacedDiff, countLines, finalizeFileChanges } from "./tool-evidence";
import { currentUserTimezone } from "./built-in-tools";
import { resolveTimeoutPolicy } from "../runtime-policy";
import { getDateLocale } from "../locale-context";
import { logger, LogTag } from "../logger";
import { getRunReviewTracker } from "./review/run-review-tracker";

const LOG_PREFIX = "[LifeTools]";

// ══════════════════════════════════════════════════════════
// 记账
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
    name: "记账",
    description:
      "记录一笔支出。\n\n" +
      "何时用：\n" +
      "- 用户说「花了 X 元买 Y」「记一下支出」「记账」\n" +
      "- 用户提到具体金额和用途\n\n" +
      "不要用于：\n" +
      "- 查账（用 query_expense）\n" +
      "- 收入记录（暂不支持）\n\n" +
      "参数：amount（金额，数字），category（分类：餐饮/交通/购物/娱乐/生活/其他），note（备注）。",
    enabled: true,
    risk: "safe",
    modes: ["work"],
    effectKind: "external_side_effect" as const,
    inputSchema: {
      type: "object",
      properties: {
        amount:   { type: "number", description: "金额（元）" },
        category: { type: "string", description: "分类：餐饮/交通/购物/娱乐/生活/其他" },
        note:     { type: "string", description: "备注" },
      },
      required: ["amount"],
    },
    execute: async (args) => {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return "[错误] amount 必须是正数";
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
      console.log(LOG_PREFIX, "记账:", rec);
      return `[record_expense] 已记录：${amount} 元 / ${rec.category} / ${rec.note}`;
    },
  });

  toolRegistry.register({
    id: "query_expense",
    name: "查账",
    description:
      "查询支出记录。\n\n" +
      "何时用：\n" +
      "- 用户问「这个月花了多少」「最近记账」「支出明细」\n" +
      "- 用户想看支出汇总\n\n" +
      "不要用于：\n" +
      "- 记新的一笔（用 record_expense）\n\n" +
      "参数：days（最近 N 天，默认 30），category（可选，按分类过滤），summary（可选，true 只返回汇总）。",
    enabled: true,
    risk: "safe",
    modes: ["work"],
    effectKind: "read" as const,
    verificationPolicy: "none" as const,
    inputSchema: {
      type: "object",
      properties: {
        days:     { type: "number", description: "最近 N 天，默认 30" },
        category: { type: "string", description: "可选，按分类过滤" },
        summary:  { type: "boolean", description: "可选，true 只返回汇总" },
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
        return `[query_expense] 最近 ${days} 天没有记账记录`;
      }
      if (args.summary) {
        const total = records.reduce((s, r) => s + r.amount, 0);
        const byCat: Record<string, number> = {};
        for (const r of records) {
          byCat[r.category] = (byCat[r.category] || 0) + r.amount;
        }
        return `[query_expense] 最近 ${days} 天共 ${records.length} 笔，合计 ${total.toFixed(2)} 元\n分类：${JSON.stringify(byCat)}`;
      }
      const lines = records.map(r => {
        const d = new Date(r.ts).toLocaleDateString(getDateLocale(), { timeZone: currentUserTimezone() });
        return `${d} ${r.amount}元 ${r.category} ${r.note}`;
      });
      return `[query_expense] 最近 ${days} 天 ${records.length} 笔：\n${lines.join("\n")}`;
    },
  });
}

// ══════════════════════════════════════════════════════════
// 汇率
// ══════════════════════════════════════════════════════════

function registerExchangeRateTool(): void {
  toolRegistry.register({
    id: "exchange_rate",
    name: "汇率查询",
    description:
      "查询货币汇率并换算。\n\n" +
      "何时用：\n" +
      "- 用户问「X 美元等于多少人民币」「100 日元换多少人民币」\n" +
      "- 用户提到货币换算\n\n" +
      "不要用于：\n" +
      "- 加密货币（不支持）\n" +
      "- 历史汇率（只支持最新）\n\n" +
      "参数：from（源货币代码，如 USD/EUR/JPY/CNY），to（目标货币），amount（金额，默认 1）。",
    enabled: true,
    risk: "network",
    effectKind: "read" as const,
    verificationPolicy: "none" as const,
    inputSchema: {
      type: "object",
      properties: {
        from:   { type: "string", description: "源货币代码，如 USD/EUR/JPY/CNY" },
        to:     { type: "string", description: "目标货币代码" },
        amount: { type: "number", description: "金额，默认 1" },
      },
      required: ["from", "to"],
    },
    execute: async (args) => {
      const from = String(args.from || "USD").toUpperCase();
      const to = String(args.to || "CNY").toUpperCase();
      const amount = Number(args.amount) || 1;
      if (from === to) {
        return `[exchange_rate] ${amount} ${from} = ${amount} ${to}（同币种）`;
      }
      // frankfurter.app 免费、无 key、支持主要货币
      const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        return `[错误] 汇率查询失败：HTTP ${resp.status}`;
      }
      const data = await resp.json() as { rates?: Record<string, number> };
      const rate = data.rates?.[to];
      if (!rate) {
        return `[exchange_rate] 查不到 ${from} → ${to}，可能是不支持的币种`;
      }
      const result = (amount * rate).toFixed(2);
      return `[exchange_rate] ${amount} ${from} = ${result} ${to}（汇率 ${rate}，更新于 ${new Date().toLocaleDateString(getDateLocale(), { timeZone: currentUserTimezone() })}）`;
    },
  });
}

// ══════════════════════════════════════════════════════════
// 翻译
// ══════════════════════════════════════════════════════════

// 翻译需要调主模型，注入由 index.ts 完成
let modelSettingsGetter: (() => { provider: string; baseUrl: string; model: string; apiKey: string; explicitTransport?: "openai" | "anthropic" | "responses" | "auto" } | null) | null = null;

/** index.ts 启动时注入模型设置读取器。 */
export function setTranslateConfig(getter: () => { provider: string; baseUrl: string; model: string; apiKey: string; explicitTransport?: "openai" | "anthropic" | "responses" | "auto" } | null): void {
  modelSettingsGetter = getter;
}

function registerTranslateTool(): void {
  toolRegistry.register({
    id: "translate",
    name: "翻译",
    description:
      "翻译文本。\n\n" +
      "何时用：\n" +
      "- 用户说「翻译 X」「这句话用 Y 语怎么说」「X 是什么意思」\n" +
      "- 用户问外语词义\n\n" +
      "不要用于：\n" +
      "- 用户用中文问中文能答的事\n" +
      "- 长文档翻译（建议分段）\n\n" +
      "参数：text（要翻译的文本），to（目标语言，如「英文」「中文」「日文」），from（可选，源语言，默认自动检测）。",
    enabled: true,
    risk: "network",
    effectKind: "read" as const,
    verificationPolicy: "none" as const,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要翻译的文本" },
        to:   { type: "string", description: "目标语言，如「英文」「中文」「日文」" },
        from: { type: "string", description: "可选，源语言，默认自动检测" },
      },
      required: ["text", "to"],
    },
    execute: async (args) => {
      const text = String(args.text || "");
      const to = String(args.to || "");
      if (!text || !to) return "[错误] text 和 to 不能为空";

      const settings = modelSettingsGetter?.();
      if (!settings || !settings.apiKey) {
        return "[错误] 未配置模型，翻译不可用";
      }

      // 动态 import 避免循环依赖；协议跟随档案配置（explicitTransport），与主链路同源
      const { getAdapterForConfig } = await import("./vendors");
      const fromHint = args.from ? `（源语言：${args.from}）` : "（自动检测源语言）";
      const sysPrompt = `你是翻译器${fromHint}。把以下文本翻译成${to}，只输出译文，不要任何解释或额外文字。`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), resolveTimeoutPolicy({ stage: "external-http" }).totalMs);
      try {
        const adapter = getAdapterForConfig(settings);
        const http = adapter.buildRequest(
          {
            model: settings.model,
            messages: [
              { role: "system", content: sysPrompt },
              { role: "user", content: text },
            ],
            maxTokens: 2000,
            stream: false,
          },
          settings,
        );
        const resp = await fetch(http.url, {
          method: "POST",
          signal: ctrl.signal,
          headers: http.headers,
          body: http.body,
        });
        if (!resp.ok) return `[错误] 翻译失败：HTTP ${resp.status}`;
        const data = await resp.json();
        const result = adapter.parseResponse(data).text.trim();
        if (!result) return "[错误] 翻译返回空";
        return `[translate] ${result}`;
      } catch (e) {
        return "[错误] 翻译失败：" + (e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

// ══════════════════════════════════════════════════════════
// 代码补丁
// ══════════════════════════════════════════════════════════

interface MatchPosition {
  line: number;       // 1-based 行号
  context: string;    // 匹配位置前后各 2 行上下文
}

/** 计算两个字符串的相似度（0-1） */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  // 简单的字符集相似度
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const c of setA) {
    if (setB.has(c)) intersection++;
  }
  return intersection / Math.max(setA.size, setB.size);
}

/** 在文件行中查找最接近 old_string 的位置 */
function findNearestMatch(
  lines: string[],
  oldStr: string,
): { line: number; similarity: number; context: string } | null {
  const oldLines = oldStr.split("\n");
  const firstLine = oldLines[0]?.trim() || "";
  if (!firstLine) return null;

  let bestMatch: { line: number; sim: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sim = similarity(firstLine, line.trim());
    if (sim > 0.5 && (!bestMatch || sim > bestMatch.sim)) {
      bestMatch = { line: i + 1, sim };
    }
  }

  if (!bestMatch) return null;

  // 收集上下文（前后各 2 行）
  const contextStart = Math.max(0, bestMatch.line - 3);
  const contextEnd = Math.min(lines.length, bestMatch.line + 2);
  const contextLines = lines.slice(contextStart, contextEnd).map((l, idx) => {
    const ln = contextStart + idx + 1;
    const marker = ln === bestMatch!.line ? ">" : " ";
    return `${marker} ${String(ln).padStart(4)} | ${l}`;
  });

  return {
    line: bestMatch.line,
    similarity: bestMatch.sim,
    context: contextLines.join("\n"),
  };
}

/** 查找所有匹配位置和上下文 */
function findAllMatchPositions(lines: string[], oldStr: string): MatchPosition[] {
  const positions: MatchPosition[] = [];
  const oldLines = oldStr.split("\n");
  const firstLine = oldLines[0] || "";

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(firstLine)) {
      // 检查完整匹配
      const candidate = lines.slice(i, i + oldLines.length).join("\n");
      if (candidate === oldStr) {
        const contextStart = Math.max(0, i - 2);
        const contextEnd = Math.min(lines.length, i + oldLines.length + 2);
        const contextLines = lines.slice(contextStart, contextEnd).map((l, idx) => {
          const ln = contextStart + idx + 1;
          const marker = (ln >= i + 1 && ln <= i + oldLines.length) ? ">" : " ";
          return `${marker} ${String(ln).padStart(4)} | ${l}`;
        });

        positions.push({
          line: i + 1,
          context: contextLines.join("\n"),
        });
      }
    }
  }

  return positions;
}

function registerStrReplaceTool(): void {
  toolRegistry.register({
    id: "str_replace",
    name: "精确替换",
    description:
      "对单个文件应用精确的字符串替换。\n\n" +
      "何时用：\n" +
      "- 修改现有文件中的一处特定代码片段\n" +
      "- 用户要「把 X 改成 Y」「把第 N 行的 A 替换成 B」\n\n" +
      "不要用于：\n" +
      "- 同一文件多处修改、或多文件批量修改（用 apply_patch 补丁格式）\n" +
      "- 整文件重写（用 write_file）\n" +
      "- 新建文件（用 write_file）\n\n" +
      "参数：file_path（文件路径），old_string（要替换的原文本，必须精确匹配含缩进），new_string（替换后的文本）。\n" +
      "old_string 必须在文件中唯一；匹配多处会报错，需要更长的上下文使其唯一。",
    enabled: true,
    risk: "fs-write",
    modes: ["code", "work"],
    effectKind: "mutation" as const,
    verificationPolicy: "code" as const,
    inputSchema: {
      type: "object",
      properties: {
        file_path:   { type: "string", description: "文件绝对路径" },
        old_string:  { type: "string", description: "要替换的原文本（必须精确匹配，含缩进）" },
        new_string:  { type: "string", description: "替换后的文本" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    execute: async (args, ctx?) => {
      const filePath = String(args.file_path || "");
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      console.log(LOG_PREFIX, "str_replace:", filePath, "old_len=" + oldStr.length, "new_len=" + newStr.length);
      if (!filePath) return JSON.stringify({ success: false, errorCode: "INVALID_PATH", error: "file_path 不能为空", retryable: false });
      if (!fs.existsSync(filePath)) {
        return JSON.stringify({
          success: false,
          errorCode: "FILE_NOT_FOUND",
          error: `文件不存在：${filePath}。不要重复相同路径，请先用 read_file 或 search_text 确认文件存在。`,
          retryable: true,
        });
      }

      const content = fs.readFileSync(filePath, "utf8");
      if (!oldStr) return JSON.stringify({ success: false, errorCode: "INVALID_INPUT", error: "old_string 不能为空", retryable: false });

      // EOL 归一化：模型通常按 LF 提供文本，而 Windows 文件常为 CRLF。
      // 精确字节匹配失败率极高 → 匹配前先把 old/new 对齐到文件的实际 EOL，写入时保持文件原有换行风格。
      let matchStr = oldStr;
      let replaceStr = newStr;
      if (content.includes("\r\n") && !oldStr.includes("\r")) {
        matchStr = oldStr.replaceAll("\n", "\r\n");
        replaceStr = newStr.replaceAll("\n", "\r\n");
      } else if (!content.includes("\r\n") && oldStr.includes("\r\n")) {
        matchStr = oldStr.replaceAll("\r\n", "\n");
        replaceStr = newStr.replaceAll("\r\n", "\n");
      }
      const eolNormalized = matchStr !== oldStr;

      const lines = content.split("\n");
      const count = content.split(matchStr).length - 1;

      if (count === 0) {
        // old_string 未找到：提供最近似候选和上下文
        const nearest = findNearestMatch(lines, oldStr);
        return JSON.stringify({
          success: false,
          errorCode: "OLD_STRING_NOT_FOUND",
          error: "old_string 在文件中未找到。已自动尝试 CRLF/LF 换行归一化仍未匹配，请用 read_file 核对实际内容（缩进、空格、标点）后重试。",
          retryable: false,
          diagnostic: {
            kind: "not_found",
            filePath,
            oldStringLength: oldStr.length,
            fileEol: content.includes("\r\n") ? "CRLF" : "LF",
            nearestMatch: nearest ? {
              line: nearest.line,
              similarity: nearest.similarity,
              context: nearest.context,
            } : null,
          },
        });
      }

      if (count > 1) {
        // 多处匹配：提供所有匹配位置和上下文
        const positions = findAllMatchPositions(lines, matchStr);
        return JSON.stringify({
          success: false,
          errorCode: "MULTIPLE_MATCHES",
          error: `old_string 在文件中匹配 ${count} 处，需要更长的上下文使其唯一。`,
          retryable: false,
          diagnostic: {
            kind: "multiple_matches",
            filePath,
            matchCount: count,
            positions: positions.slice(0, 5).map(pos => ({
              line: pos.line,
              context: pos.context,
            })),
          },
        });
      }

      // Review 基线捕获：在写文件之前保存 pre-mutation baseline
      if (ctx?.runId) {
        const tracker = getRunReviewTracker(app.getPath("userData"));
        tracker.captureBefore(ctx.runId, filePath);
      }

      const newContent = content.replace(matchStr, replaceStr);
      fs.writeFileSync(filePath, newContent, "utf8");
      const size = fs.statSync(filePath).size;
      console.log(LOG_PREFIX, "str_replace:", filePath, "size=" + size, eolNormalized ? "eolNormalized=true" : "");
      // diff 展示统一按 LF 拆行，避免 CRLF 残留到卡片渲染
      const beforeLines = matchStr.replaceAll("\r\n", "\n").split("\n");
      const afterLines = replaceStr.replaceAll("\r\n", "\n").split("\n");
      return JSON.stringify({
        tool: "str_replace",
        filePath,
        action: "modified",
        sizeBytes: size,
        success: true,
        eolNormalized,
        changes: finalizeFileChanges([{
          file: filePath,
          kind: "modified",
          insertions: countLines(newStr),
          deletions: countLines(oldStr),
          diff: buildReplacedDiff(beforeLines, afterLines),
        }]),
      });
    },
  });
}

/** 注册全部生活类工具。index.ts startup 调一次。 */
export function registerLifeTools(): void {
  registerExpenseTools();
  registerExchangeRateTool();
  registerTranslateTool();
  registerStrReplaceTool();
  logger.info(LogTag.LifeTools, "registered: record_expense / query_expense / exchange_rate / translate / str_replace");
}
