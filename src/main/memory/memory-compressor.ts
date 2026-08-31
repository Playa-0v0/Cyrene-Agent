// 片段压缩 + 回顾引擎
//
// 每 20 轮触发一次：
//   阶段 A — 片段压缩：聚类相似片段条目，合并为一条总结
//   阶段 B — 回顾：审视当前画像/近况，建议更新
//
// 通过 enqueueLLMTask 在后台执行，不影响主对话流程。

import { memoryStore } from "./memory-store";
import type { L0WritableField } from "./memory-store";
import { addL2MemoryVector, deleteUserMemoryVectors, getEntriesBySource } from "../rag/index";
import { cosineSimilarity } from "../rag/vectorstore";
import { L0_FIELD_DESCRIPTIONS } from "./memory-types";
import type { L2Memory } from "./memory-types";
import { resolveL1Field } from "./memory-manager";
import { commitMemoryCompression } from "./memory-compression-transaction";
import { invokeMemoryLlm, invokeMemoryStructuredOutput, getDefaultMaxOutputTokens } from "./memory-llm-client";
import { parseMemoryReflectionResult, validateMemoryReflectionBusiness } from "./memory-schemas";
import type { MemoryReflectionItem } from "./memory-schemas";

// ── 阶段 A：片段压缩（纯文本总结，不需要结构化输出） ──

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
    console.log("[PMRS/Compressor] 活跃 L2 条目不足，跳过压缩");
    return 0;
  }

  // 从 RAG 库获取 user_memory 条目，建立 ragId → embedding 映射
  const ragEntries = getEntriesBySource("user_memory");

  // 分组
  const groups: GroupedEntry[][] = [];
  const used = new Set<string>();

  for (const l2 of activeL2) {
    if (used.has(l2.id)) continue;
    const ragEntry = ragEntries.find((e) => e.id === l2.ragId);
    if (!ragEntry) continue;

    const group: GroupedEntry[] = [{ l2, embedding: ragEntry.embedding }];
    used.add(l2.id);

    for (const other of activeL2) {
      if (used.has(other.id)) continue;
      const otherRag = ragEntries.find((e) => e.id === other.ragId);
      if (!otherRag) continue;

      const sim = cosineSimilarity(ragEntry.embedding, otherRag.embedding);
      if (sim >= SIMILARITY_THRESHOLD) {
        group.push({ l2: other, embedding: otherRag.embedding });
        used.add(other.id);
      }
    }

    if (group.length >= MIN_GROUP_SIZE) groups.push(group);
  }

  if (groups.length === 0) {
    console.log("[PMRS/Compressor] 无需压缩的组");
    return 0;
  }

  // 对每组调 LLM 生成总结
  let totalCompressed = 0;
  for (const group of groups) {
    try {
      const texts = group.map((g) => `- ${g.l2.content}`);
      const prompt = [
        "你是一个记忆总结助手。以下是一组相似的用户记忆条目，请将它们合并成一条简洁的总结。",
        "要求：",
        "- 保留所有关键信息，去重",
        "- 用中文自然语言",
        "- 控制在 100 字以内",
        "- 直接输出总结文本，不要额外解释",
        "",
        "记忆条目：",
        ...texts,
      ].join("\n");

      const result = await invokeMemoryLlm({
        operation: "compress",
        messages: [
          { role: "system", content: "你是一个简洁的记忆总结助手。" },
          { role: "user", content: prompt },
        ],
        maxOutputTokens: 300,
      });

      const cleanSummary = result.text.replace(/^["「『]|["」』]$/g, "").trim();
      if (!cleanSummary || cleanSummary.length < 5) continue;

      const subEntryIds = group.map((g) => g.l2.id);
      await commitMemoryCompression({
        content: cleanSummary,
        triggerText: group[0].l2.triggerText,
        sourceConversationId: group[0].l2.sourceConversationId,
        sources: group.map((entry) => ({
          id: entry.l2.id,
          ragId: entry.l2.ragId,
          status: entry.l2.status,
        })),
      }, {
        createSummary: (input) => memoryStore.addL2Memory(input),
        addSummaryVector: addL2MemoryVector,
        markSummarySynced: (l2Id, ragId) => memoryStore.markL2SyncStatus(l2Id, "synced", ragId),
        archiveSources: (ids) => memoryStore.archiveL2Batch(ids),
        restoreSources: async (sources) => {
          const byStatus = new Map<L2Memory["status"], string[]>();
          for (const source of sources) {
            byStatus.set(source.status, [...(byStatus.get(source.status) ?? []), source.id]);
          }
          for (const [status, ids] of byStatus) await memoryStore.updateL2Status(ids, status);
        },
        deactivateSummary: (id) => memoryStore.updateL2Status([id], "archived"),
        deleteSummary: (id) => memoryStore.deleteL2(id),
        deleteVectors: (ids) => deleteUserMemoryVectors(ids),
        warn: (message, error) => console.warn(`[PMRS/Compressor] ${message}:`, error),
      });

      // 记录日志
      await memoryStore.appendReflectionLog({
        type: "compression",
        summary: `压缩 ${subEntryIds.length} 条记忆为一条总结`,
        details: `原条目：${texts.join(" | ")}\n总结：${cleanSummary}`,
      });

      totalCompressed += subEntryIds.length;
      console.log(`[PMRS/Compressor] 压缩了 ${subEntryIds.length} 条 → "${cleanSummary.slice(0, 40)}"`);
    } catch (err) {
      console.warn("[PMRS/Compressor] 组压缩失败:", err);
    }
  }

  return totalCompressed;
}

// ── 阶段 B：回顾（画像/近况 元认知更新） ──

async function runReflection(): Promise<void> {
  try {
    const l0 = await memoryStore.getL0();
    const l1 = await memoryStore.getL1();

    if (l0.isPinned) {
      console.log("[PMRS/Recap] L0 已锁定，跳过更新建议");
    }

    // 构建 LLM prompt
    const currentProfile = [
      "当前用户画像：",
      l0.preferredName ? `  称呼：${l0.preferredName}` : "",
      l0.occupation ? `  职业：${l0.occupation}` : "",
      l0.longTermInterests ? `  长期兴趣：${l0.longTermInterests}` : "",
      l0.language ? `  常用语言：${l0.language}` : "",
      l0.permanentNote ? `  备注：${l0.permanentNote}` : "",
      "",
      "当前近期状态：",
      l1.recentGoals ? `  最近目标：${l1.recentGoals}` : "",
      l1.recentPreferences ? `  近期偏好：${l1.recentPreferences}` : "",
      l1.currentProject ? `  当前项目：${l1.currentProject}` : "",
      `  对话轮数：${l1.roundCount}`,
    ].filter(Boolean).join("\n");

    const fieldDescriptions = Object.entries(L0_FIELD_DESCRIPTIONS)
      .map(([field, desc]) => `  ${field}：${desc}`)
      .join("\n");

    const systemPrompt = [
      "你是一个谨慎的用户画像反思助手。",
      "你只能输出 JSON，不要 Markdown 代码块、不要解释、不要注释。",
      "输出必须是顶层 JSON 对象，唯一的顶层字段为 updates。",
      "updates 是 JSON 数组，每个元素格式：",
      '{ "layer": "L0" 或 "L1", "field": "字段名（可选）", "content": "新的用户画像内容", "confidence": 0.0 到 1.0 }',
      "没有更新时输出 {\"updates\":[]}。",
    ].join("\n");

    const userPrompt = [
      "回顾与用户的长期互动，判断是否需要更新用户画像或近期状态。",
      "",
      currentProfile,
      "",
      "请分析：",
      "1. 是否有信息可以更新画像字段（稳定身份信息）？",
      `   可用字段：\n${fieldDescriptions}`,
      "2. 是否有信息可以更新近况字段（近期目标/偏好/项目）？",
      "",
      "输出格式：",
      "{",
      '  "updates": [',
      '    { "layer": "L1", "field": "recentGoals", "content": "想系统性学习 Transformer", "confidence": 0.85 }',
      "  ]",
      "}",
      "",
      "近况字段可以选择 recentGoals / recentPreferences / currentProject。",
      "如果没有需要更新的信息，输出 {\"updates\":[]}。",
      "只输出 JSON，不要额外解释。",
    ].join("\n");

    const items = await invokeMemoryStructuredOutput<MemoryReflectionItem[]>({
      operation: "reflect",
      systemPrompt,
      userPrompt,
      maxOutputTokens: getDefaultMaxOutputTokens("reflect"),
      parseSchema: parseMemoryReflectionResult,
      validateBusiness: validateMemoryReflectionBusiness,
    });

    if (items.length === 0) {
      console.log("[PMRS/Recap] 无 L0/L1 更新建议");
      return;
    }

    const validFields = Object.keys(L0_FIELD_DESCRIPTIONS);
    let updateCount = 0;

    for (const item of items) {
      if (!item.content || !item.confidence || item.confidence < 0.6) continue;

      if (item.layer === "L0" && item.field && validFields.includes(item.field) && !l0.isPinned) {
        await memoryStore.upsertL0Field(item.field as L0WritableField, item.content.trim());
        await memoryStore.appendReflectionLog({
          type: "l0_update",
          summary: `L0.${item.field} 更新为 "${item.content.slice(0, 30)}"（置信度 ${item.confidence.toFixed(2)}）`,
        });
        updateCount++;
        console.log(`[PMRS/Recap] L0.${item.field} 更新: "${item.content.slice(0, 30)}"`);
      } else if (item.layer === "L1") {
        const l1Field = resolveL1Field(item.field, item.content)
        await memoryStore.replaceL1Field(l1Field, item.content.trim());
        await memoryStore.appendReflectionLog({
          type: "l1_update",
          summary: `L1.${l1Field} 更新为 "${item.content.slice(0, 30)}"（置信度 ${item.confidence.toFixed(2)}）`,
        });
        updateCount++;
        console.log(`[PMRS/Recap] L1.${l1Field} 更新: "${item.content.slice(0, 30)}"`);
      }
    }

    console.log(`[PMRS/Recap] 完成，更新了 ${updateCount} 个字段`);
  } catch (err) {
    console.warn("[PMRS/Recap] 执行失败:", err);
  }
}

// ── 公开入口 ──

/**
 * 运行片段压缩 + 回顾。
 * 由 scheduleMemoryWrite 在每 20 轮时触发。
 */
export async function runMemoryCompression(): Promise<void> {
  console.log("[PMRS/Compressor] 达到 20 轮，触发回顾 + 片段压缩");
  await runReflection();
  await compressMemories();
}

/** @deprecated Use runMemoryCompression instead. */
export const runReflectionAndCompression = runMemoryCompression;
