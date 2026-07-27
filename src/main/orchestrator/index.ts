// Orchestrator — unified entry point
// Function Calling 模式下，Orchestrator 只負責構建 always-on 上下文（世界書 + L0/L1）
// 工具的選擇和執行由 function-calling.ts 的 runFunctionCallingLoop 處理
import { updateWorldbookActivation, getPermanentWorldbookEntries, getActiveWorldbookEntries, getCascadeWorldbookEntries, searchMemory, searchMemoryEntries, INJECTION_HEADER, INJECTION_PREAMBLE } from "../rag";
import { memoryStore } from "../memory/memory-store";
import { entityGraph } from "../memory/entity-graph";
import { recordRecentMemorySearchEntries } from "../memory/recent-injected-memory";
import { toolRegistry } from "./tool-registry";

export { ToolCallResult } from "./types";
export { scheduleMemoryWrite } from "./context-builder";
export { buildToneInjection } from "./tone-injector";
export { runFunctionCallingLoop } from "./function-calling";

// topicState TTL 已移除——由 DMAE Activation 狀態機接管（見 rag/worldbook.ts）

/**
 * 構建相關記憶注入：自動檢索 top-N 相關 L2 記憶和導入文檔，
 * 注入到 system prompt 中，讓模型無需主動調用 tool 也能感知到相關信息。
 * 原有 tool 保留，模型仍可深度搜索。
 */
export async function buildMemoryInjection(
  userInput: string,
): Promise<string> {
  const parts: string[] = [];

  try {
    // 檢索 top-3 L2 用戶記憶
    const userMemoryEntries = await searchMemoryEntries(userInput, "user_memory", 5);
    if (userMemoryEntries.length > 0) {
      recordRecentMemorySearchEntries(userMemoryEntries);
      // 標註可能存在衝突的記憶
      const allL2 = await memoryStore.getAllL2();
      const conflictAnnotated = userMemoryEntries.map((entry) => {
        const m = entry.text;
        const l2Entry = allL2.find((l) => l.content === m && l.conflictWith && l.conflictWith.length > 0);
        if (l2Entry) {
          return `· ${m} ⚠️（該信息可能存在矛盾記錄）`;
        }
        return `· ${m}`;
      });
      parts.push("【相關記憶】\n" + conflictAnnotated.join("\n"));
    }
  } catch (err) {
    console.warn("[Orchestrator] user_memory search failed:", err);
  }

  try {
    // 檢索 top-2 導入文檔片段
    const docResults = await searchMemory(userInput, "imported_doc", 2);
    if (docResults.length > 0) {
      parts.push("【相關文檔】\n" + docResults.map((d) => "· " + d).join("\n"));
    }
  } catch (err) {
    console.warn("[Orchestrator] imported_doc search failed:", err);
  }

  try {
    // 實體關係圖譜
    const entityInfo = entityGraph.search(userInput);
    if (entityInfo) {
      parts.push("【人物關係】\n" + entityInfo);
    }
  } catch (err) {
    console.warn("[Orchestrator] entity graph search failed:", err);
  }

  return parts.join("\n\n");
}

/**
 * 構建 always-on 上下文：世界書 + L0/L1 畫像。
 * 不涉及工具選擇和執行——那些由 function calling 處理。
 */
export async function buildAlwaysOnContext(
  userInput: string,
  recentMessages: Array<{ role: string; content: string }>,
): Promise<string> {
  const parts: string[] = [];

  // ── 世界書 — 永遠跑 ──────────────────────────────────
  // DMAE：常駐始終注入；非常駐條目按 Activation 生命週期門控。
  // updateActivation 在調 LLM 之前跑 → 用戶當輪命中的條目當輪就進 Prompt。
  try {
    const permanentWb = getPermanentWorldbookEntries();
    if (permanentWb.length > 0) {
      parts.push("【常駐背景】\n" + permanentWb.join("\n\n"));
    }

    const lastAssistant = recentMessages
      .filter(m => m.role === "assistant")
      .slice(-1)[0]?.content ?? "";
    updateWorldbookActivation(userInput, lastAssistant);  // 打分（本輪用戶 + 上輪模型）
    const active = getActiveWorldbookEntries();           // 閾值門控 + 注入
    // One-Shot cascade：用戶命中後連帶觸發的條目（不入 DMAE 狀態表，只本輪有效）
    const cascade = getCascadeWorldbookEntries();
    const allInjected = active.length > 0 || cascade.length > 0;
    if (allInjected) {
      const sections: string[] = [];
      if (active.length > 0) {
        sections.push(active.join("\n\n"));
      }
      if (cascade.length > 0) {
        sections.push(cascade.join("\n\n"));
      }
      parts.push(INJECTION_HEADER + "\n" + INJECTION_PREAMBLE + "\n\n" + sections.join("\n\n"));
    }
  } catch (err) {
    console.warn("[Orchestrator] worldbook dmae failed:", err);
  }

  // ── L0/L1 畫像 — 永遠跑 ──────────────────────────────
  try {
    const l0 = await memoryStore.getL0();
    const l1 = await memoryStore.getL1();

    const l0Lines = [
      l0.preferredName && `稱呼：${l0.preferredName}`,
      l0.occupation && `職業：${l0.occupation}`,
      l0.longTermInterests && `長期興趣：${l0.longTermInterests}`,
      l0.language && `常用語言：${l0.language}`,
      l0.permanentNote && `備註：${l0.permanentNote}`,
    ].filter(Boolean);

    const l1Lines = [
      l1.recentGoals && `最近目標：${l1.recentGoals}`,
      l1.recentPreferences && `近期偏好：${l1.recentPreferences}`,
      l1.currentProject && `當前項目：${l1.currentProject}`,
    ].filter(Boolean);

    if (l0Lines.length > 0 || l1Lines.length > 0) {
      let memoryContext = "";
      if (l0Lines.length > 0) {
        memoryContext += `[用戶畫像]\n${l0Lines.join("\n")}\n\n`;
      }
      if (l1Lines.length > 0) {
        memoryContext += `[近期狀態]\n${l1Lines.join("\n")}\n\n`;
      }
      parts.push(memoryContext.trim());
    }
  } catch (err) {
    console.warn("[Orchestrator] memory load failed:", err);
  }

  // ── 日誌 ──────────────────────────────────────────────
  const enabledTools = toolRegistry.getEnabledTools();
  console.log("[Orchestrator] Always-on context built, enabled tools: " + enabledTools.map(t => t.id).join(", "));

  return parts.join("\n\n");
}
