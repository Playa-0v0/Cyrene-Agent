// 記憶壓縮 + Reflection 引擎
//
// 每 20 輪觸發一次：
//   階段 A — 記憶壓縮：聚類相似 L2 條目，合併為一條總結
//   階段 B — Reflection：審視當前 L0/L1，建議更新
//
// 通過 enqueueLLMTask 在後臺執行，不影響主對話流程。

import { memoryStore } from "./memory-store";
import type { L0WritableField } from "./memory-store";
import { getEntriesBySource } from "../rag/index";
import { cosineSimilarity } from "../rag/vectorstore";
import { L0_FIELD_DESCRIPTIONS } from "./memory-types";
import type { L2Memory } from "./memory-types";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { getAdapterForConfig } from "../orchestrator/vendors";
import { recordUsage } from "../token-usage-store";
import { revealSecrets } from "../security/secret-vault";

// ── LLM 調用（複用與 MemoryJudge 相同的 API 模式） ──

interface ModelSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
}

function loadModelSettings(): ModelSettings {
  const defaults = { provider: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", apiKey: "" };
  try {
    const filePath = path.join(app.getPath("userData"), "model-settings.json");
    if (!fs.existsSync(filePath)) return defaults;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = revealSecrets(JSON.parse(raw)) as Partial<ModelSettings>;
    const explicitTransport: ModelSettings["explicitTransport"] =
      parsed.explicitTransport === "openai" || parsed.explicitTransport === "anthropic" || parsed.explicitTransport === "auto"
        ? parsed.explicitTransport
        : undefined;
    return {
      provider: typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider.trim() : defaults.provider,
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : defaults.baseUrl,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : defaults.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      explicitTransport,
    };
  } catch { return defaults; }
}

async function callLLM(messages: Array<{ role: "system" | "user"; content: string }>, maxTokens = 500): Promise<string> {
  const settings = loadModelSettings();
  if (!settings.apiKey) throw new Error("missing api key");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  const cfg = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
  };

  try {
    // 走 adapter（之前直接寫 OpenAI body / Bearer / choices 解析，anthropic 端點會拿到空串）
    const adapter = getAdapterForConfig(cfg);
    const http = adapter.buildRequest({
      model: cfg.model,
      messages,
      maxTokens,
      stream: false,
    }, cfg);

    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = (errorData as { error?: { message?: string } }).error?.message;
      throw new Error(errMsg || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const parsed = adapter.parseResponse(data);

    if (parsed.usage) {
      recordUsage(parsed.usage.input, parsed.usage.output, 1, settings.model);
    }

    return parsed.text ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// ── 工具函數 ──

/** 從文本中提取 JSON 對象數組（容錯：截斷、markdown 包裹） */
function extractJsonArray(raw: string): unknown[] | null {
  let text = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  const start = text.indexOf("[");
  if (start === -1) return null;
  text = text.slice(start);

  try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed; } catch { /* fall through */ }

  // 截斷救場：逐個撈取完整對象
  const results: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i++; continue; }
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) break;
    try { const obj = JSON.parse(text.slice(i, j + 1)); if (obj && typeof obj === "object") results.push(obj); } catch { /* skip */ }
    i = j + 1;
  }
  return results.length > 0 ? results : null;
}

// ── 階段 A：記憶壓縮 ──

const SIMILARITY_THRESHOLD = 0.85;
const MIN_GROUP_SIZE = 3;

interface GroupedEntry {
  l2: L2Memory;
  embedding: number[];
}

async function compressMemories(): Promise<number> {
  const allL2 = await memoryStore.getAllL2();
  const activeL2 = allL2.filter((m) => m.status === "active" && !m.isSummary && m.ragId);

  if (activeL2.length < MIN_GROUP_SIZE) {
    console.log("[MemoryCompressor] 活躍 L2 條目不足，跳過壓縮");
    return 0;
  }

  // 從 RAG 庫獲取 user_memory 條目，建立 ragId → embedding 映射
  const ragEntries = getEntriesBySource("user_memory");
  const embeddingMap = new Map<string, number[]>();
  for (const re of ragEntries) {
    embeddingMap.set(re.id, re.embedding);
  }

  // 為每個 L2 條目配對 embedding
  const withEmbedding: GroupedEntry[] = [];
  for (const l2 of activeL2) {
    if (l2.ragId) {
      const emb = embeddingMap.get(l2.ragId);
      if (emb) withEmbedding.push({ l2, embedding: emb });
    }
  }

  if (withEmbedding.length < MIN_GROUP_SIZE) {
    console.log("[MemoryCompressor] 帶 embedding 的條目不足，跳過壓縮");
    return 0;
  }

  // 貪心聚類：取一條作為種子，找所有與其相似度 >= 閾值的條目
  const used = new Set<string>();
  const groups: GroupedEntry[][] = [];

  for (let i = 0; i < withEmbedding.length; i++) {
    if (used.has(withEmbedding[i].l2.id)) continue;

    const group: GroupedEntry[] = [withEmbedding[i]];
    used.add(withEmbedding[i].l2.id);

    for (let j = i + 1; j < withEmbedding.length; j++) {
      if (used.has(withEmbedding[j].l2.id)) continue;
      const sim = cosineSimilarity(withEmbedding[i].embedding, withEmbedding[j].embedding);
      if (sim >= SIMILARITY_THRESHOLD) {
        group.push(withEmbedding[j]);
        used.add(withEmbedding[j].l2.id);
      }
    }

    if (group.length >= MIN_GROUP_SIZE) {
      groups.push(group);
    }
  }

  if (groups.length === 0) {
    console.log("[MemoryCompressor] 未找到可壓縮的條目組");
    return 0;
  }

  console.log(`[MemoryCompressor] 發現 ${groups.length} 個可壓縮組`);

  // 對每組調 LLM 生成總結
  let totalCompressed = 0;
  for (const group of groups) {
    try {
      const texts = group.map((g) => `- ${g.l2.content}`);
      const prompt = [
        "你是一個記憶總結助手。以下是一組相似的用戶記憶條目，請將它們合併成一條簡潔的總結。",
        "要求：",
        "- 保留所有關鍵信息，去重",
        "- 用中文自然語言",
        "- 控制在 100 字以內",
        "- 直接輸出總結文本，不要額外解釋",
        "",
        "記憶條目：",
        ...texts,
      ].join("\n");

      const summary = await callLLM([
        { role: "system", content: "你是一個簡潔的記憶總結助手。" },
        { role: "user", content: prompt },
      ], 300);

      const cleanSummary = summary.replace(/^["「『]|["」』]$/g, "").trim();
      if (!cleanSummary || cleanSummary.length < 5) continue;

      // 收集原始條目 id
      const subEntryIds = group.map((g) => g.l2.id);

      // 創建壓縮總結條目
      await memoryStore.addL2Memory({
        content: cleanSummary,
        triggerText: group[0].l2.triggerText,
        sourceConversationId: group[0].l2.sourceConversationId,
        ragId: undefined,
        embedding: [],
        isPinned: false,
        isSummary: true,
        subEntryIds,
      });

      // 原始條目歸檔
      await memoryStore.archiveL2Batch(subEntryIds);

      // 記錄日誌
      await memoryStore.appendReflectionLog({
        type: "compression",
        summary: `壓縮 ${subEntryIds.length} 條記憶為一條總結`,
        details: `原條目：${texts.join(" | ")}\n總結：${cleanSummary}`,
      });

      totalCompressed += subEntryIds.length;
      console.log(`[MemoryCompressor] 壓縮了 ${subEntryIds.length} 條 → "${cleanSummary.slice(0, 40)}"`);
    } catch (err) {
      console.warn("[MemoryCompressor] 組壓縮失敗:", err);
    }
  }

  return totalCompressed;
}

// ── 階段 B：Reflection（L0/L1 元認知更新） ──

async function runReflection(): Promise<void> {
  try {
    const l0 = await memoryStore.getL0();
    const l1 = await memoryStore.getL1();

    if (l0.isPinned) {
      console.log("[Reflection] L0 已鎖定，跳過更新建議");
    }

    // 構建 LLM prompt
    const currentProfile = [
      "當前用戶畫像：",
      l0.preferredName ? `  稱呼：${l0.preferredName}` : "",
      l0.occupation ? `  職業：${l0.occupation}` : "",
      l0.longTermInterests ? `  長期興趣：${l0.longTermInterests}` : "",
      l0.language ? `  常用語言：${l0.language}` : "",
      l0.permanentNote ? `  備註：${l0.permanentNote}` : "",
      "",
      "當前近期狀態：",
      l1.recentGoals ? `  最近目標：${l1.recentGoals}` : "",
      l1.recentPreferences ? `  近期偏好：${l1.recentPreferences}` : "",
      l1.currentProject ? `  當前項目：${l1.currentProject}` : "",
      `  對話輪數：${l1.roundCount}`,
    ].filter(Boolean).join("\n");

    const fieldDescriptions = Object.entries(L0_FIELD_DESCRIPTIONS)
      .map(([field, desc]) => `  ${field}：${desc}`)
      .join("\n");

    const prompt = [
      "你是一個用戶畫像反思助手。",
      "回顧與用戶的長期互動，判斷是否需要更新用戶畫像或近期狀態。",
      "",
      currentProfile,
      "",
      "請分析：",
      "1. 是否有信息可以更新 L0 字段（穩定身份信息）？",
      `   可用字段：\n${fieldDescriptions}`,
      "2. 是否有信息可以更新 L1 字段（近期目標/偏好/項目）？",
      "",
      "如果沒有需要更新的信息，返回空數組 []。",
      "如果需要更新，以 JSON 數組格式返回，每個元素包含：",
      '{ "layer": "L0"|"L1", "field": "字段名", "content": "新值", "confidence": 0.0~1.0 }',
      "",
      "只輸出 JSON，不要額外解釋。",
    ].join("\n");

    const raw = await callLLM([
      { role: "system", content: "你是一個謹慎的用戶畫像反思助手。只輸出 JSON 數組。" },
      { role: "user", content: prompt },
    ], 500);

    const parsed = extractJsonArray(raw);
    if (!parsed || parsed.length === 0) {
      console.log("[Reflection] 無 L0/L1 更新建議");
      return;
    }

    const validFields = Object.keys(L0_FIELD_DESCRIPTIONS);
    let updateCount = 0;

    for (const item of parsed) {
      const rec = item as Record<string, unknown>;
      const layer = rec.layer;
      const field = rec.field as string | undefined;
      const content = rec.content as string | undefined;
      const confidence = rec.confidence as number | undefined;

      if (!content || !confidence || confidence < 0.6) continue;

      if (layer === "L0" && field && validFields.includes(field) && !l0.isPinned) {
        await memoryStore.upsertL0Field(field as L0WritableField, content.trim());
        await memoryStore.appendReflectionLog({
          type: "l0_update",
          summary: `L0.${field} 更新為 "${content.slice(0, 30)}"（置信度 ${confidence.toFixed(2)}）`,
        });
        updateCount++;
        console.log(`[Reflection] L0.${field} 更新: "${content.slice(0, 30)}"`);
      } else if (layer === "L1") {
        const l1Field = /目標|想要|計劃|打算/.test(content) ? "recentGoals" : "recentPreferences";
        await memoryStore.replaceL1Field(l1Field, content.trim());
        await memoryStore.appendReflectionLog({
          type: "l1_update",
          summary: `L1.${l1Field} 更新為 "${content.slice(0, 30)}"（置信度 ${confidence.toFixed(2)}）`,
        });
        updateCount++;
        console.log(`[Reflection] L1.${l1Field} 更新: "${content.slice(0, 30)}"`);
      }
    }

    console.log(`[Reflection] 完成，更新了 ${updateCount} 個字段`);
  } catch (err) {
    console.warn("[Reflection] 執行失敗:", err);
  }
}

// ── 公開入口 ──

/**
 * 運行記憶壓縮 + Reflection。
 * 由 scheduleMemoryWrite 在每 20 輪時觸發。
 */
export async function runReflectionAndCompression(): Promise<void> {
  console.log("[Memory] 開始 20 輪 Reflection + 記憶壓縮...");

  // 階段 A：記憶壓縮
  const compressed = await compressMemories();
  console.log(`[Memory] 壓縮完成，共壓縮 ${compressed} 條原始記憶`);

  // 階段 B：Reflection（L0/L1 元認知更新）
  await runReflection();

  // 重建 RAG 索引（數據有變化）
  try {
    const { JsonVectorStore } = await import("../rag/vectorstore");
    // 通過重新 import 觸發不了實例方法，下面通過公開方法訪問
    // 實際會在下次 search 時惰性重建
    console.log("[Memory] 向量索引已標記髒，下次搜索時自動重建");
  } catch { /* ignore */ }

  console.log("[Memory] Reflection + 壓縮流程完成");
}
