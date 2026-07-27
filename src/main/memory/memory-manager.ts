import { memoryStore } from "./memory-store"
import type { L0WritableField } from "./memory-store"
import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, L2Memory } from "./memory-types"
import { findPossibleConflictCandidate } from "./memory-conflict"
import { scoreMemoryConflict, type ConflictEvidenceLevel } from "./memory-conflict-score"
import { wasRecentlyInjectedMemory } from "./recent-injected-memory"
import { addMemory, searchMemoryEntries } from "../rag/index"

type L1Field = "recentGoals" | "recentPreferences"

function preview(content: string, maxLength: number): string {
  return content.slice(0, maxLength)
}

function getL1Field(content: string): L1Field {
  if (/目標|想要|計劃|打算/.test(content)) return "recentGoals"
  return "recentPreferences"
}

function hasCorrectionIntent(text: string): boolean {
  return ["不是這樣", "你記錯了", "記錯了", "我現在不這樣", "現在不這樣"].some((phrase) => text.includes(phrase))
}

function getImpactScope(memory: L2Memory): "low" | "medium" | "high" {
  if (memory.isPinned) return "high"
  if (memory.status === "active") return "medium"
  return "low"
}

function shouldSkipCandidate(candidate: MemoryCandidate): boolean {
  return candidate.shouldWrite === false || Boolean(candidate.forbiddenOverclaims && candidate.forbiddenOverclaims.length > 0)
}

function canWriteCoreProfile(candidate: MemoryCandidate): boolean {
  return candidate.certainty === "explicit" && candidate.attribution === "user_explicit"
}

export class MemoryManager {
  private async appendToPermanentNote(content: string): Promise<void> {
    const l0 = await memoryStore.getL0()
    const existing = l0.permanentNote || ""
    const updated = existing ? `${existing}；${content}` : content
    await memoryStore.upsertL0Field("permanentNote", updated)
  }

  async writeMemory(candidates: MemoryCandidate[]): Promise<void> {
    for (const candidate of candidates) {
      if (shouldSkipCandidate(candidate)) {
        console.log("[MemoryManager] 候選標記為不寫入或存在過度概括，跳過")
        continue
      }

      if (candidate.layer === "L0") {
        if (!canWriteCoreProfile(candidate)) {
          console.log("[MemoryManager] L0 候選不是用戶明確事實，跳過自動寫核心畫像")
          continue
        }

        // 如果 L0 被用戶鎖定，跳過
        const l0 = await memoryStore.getL0()
        if (l0.isPinned) {
          console.log("[MemoryManager] L0 已鎖定，跳過自動更新")
          continue
        }

        // 從唯一事實來源獲取合法字段列表
        const validFields = Object.keys(L0_FIELD_DESCRIPTIONS)

        // 情況一：AI 沒有輸出 field 字段（理論上不該發生）
        if (!candidate.field) {
          console.warn("[MemoryManager] L0 候選缺少 field 字段，跳過自動寫核心畫像")
          continue
        }

        // 情況二：AI 輸出了非法字段名（幻覺）
        if (!validFields.includes(candidate.field)) {
          console.warn(`[MemoryManager] AI 返回非法字段 "${candidate.field}"，跳過自動寫核心畫像`)
          continue
        }

        // 情況三：合法字段，直接寫入
        await memoryStore.upsertL0Field(candidate.field as L0WritableField, candidate.content)
        console.log(`[MemoryManager] L0 更新字段: ${candidate.field} = "${candidate.content.slice(0, 20)}"`)
      } else if (candidate.layer === "L1") {
        const field = getL1Field(candidate.content)
        await memoryStore.replaceL1Field(field, candidate.content)
        console.log(`[MemoryManager] L1 更新字段: ${field}`)
      } else if (candidate.layer === "L2") {
        await this.writeL2(candidate)
      }
    }
  }

  private async writeL2(candidate: MemoryCandidate): Promise<void> {
    const l2Input: Omit<L2Memory, "id" | "createdAt" | "lastAccessedAt" | "accessCount" | "weight" | "status"> = {
      content: candidate.content,
      triggerText: candidate.triggerText,
      sourceConversationId: "",
      embedding: [],
      isPinned: false,
      syncStatus: "pending_sync",
    }

    const l2 = await memoryStore.addL2Memory(l2Input)

    let ragId: string | undefined
    try {
      ragId = await addMemory(candidate.content, "user_memory", {
        triggerText: candidate.triggerText,
        confidence: candidate.confidence,
        l2Id: l2.id,
      })
      await memoryStore.markL2SyncStatus(l2.id, "synced", ragId)
    } catch (err) {
      await memoryStore.markL2SyncStatus(l2.id, "sync_failed", undefined, err)
      console.warn("[MemoryManager] L2 已寫入，但 RAG 同步失敗:", err)
      return
    }

    console.log(`[MemoryManager] L2 寫入: "${preview(candidate.content, 30)}"（l2Id: ${l2.id}, ragId: ${ragId}）`)

    // ── 衝突檢測：檢查新記憶是否與現有記憶矛盾 ──
    try {
      await this.detectAndMarkConflicts(candidate.content, l2.id, ragId, candidate.triggerText)
    } catch (err) {
      console.warn("[MemoryManager] 衝突檢測失敗:", err)
    }
  }

  /** 檢測新記憶是否與現有 active 記憶矛盾，如有則標記 */
  private async detectAndMarkConflicts(content: string, newL2Id: string, newRagId: string, triggerText: string): Promise<void> {
    // 搜索語義相似的現有 L2 條目
    const allL2 = await memoryStore.getAllL2()
    const activeL2 = allL2.filter((m) => (m.status === "active" || m.status === "aging") && m.ragId && m.ragId !== newRagId)

    // 用 RAG entry 做向量相似度匹配，優先讀取 metadata.l2Id 精確定位 L2。
    const similarEntries = await searchMemoryEntries(content, "user_memory", 5, { recordRecall: false })
    if (similarEntries.length === 0) return

    const entriesByL2Id = new Map<string, (typeof similarEntries)[number]>()
    for (const entry of similarEntries) {
      const l2Id = entry.metadata?.l2Id
      if (typeof l2Id === "string" && l2Id.length > 0) {
        entriesByL2Id.set(l2Id, entry)
      }
    }

    // 在 activeL2 中找 RAG 定位到的候選，再檢查是否存在本地弱矛盾信號。
    for (const existing of activeL2) {
      const metadataMatch = entriesByL2Id.get(existing.id)
      const textMatch = similarEntries.find((entry) => (
        entry.text === existing.content ||
        existing.content.includes(entry.text.slice(0, 20)) ||
        entry.text.includes(existing.content.slice(0, 20))
      ))
      const matchedEntry = metadataMatch ?? textMatch
      if (!matchedEntry) continue

      const candidate = findPossibleConflictCandidate(content, existing.content)
      if (candidate.isCandidate) {
        // 本地規則只產出疑似候選，不確認衝突真偽。
        const marked = await memoryStore.markL2Conflict(existing.id, newRagId)
        if (marked) {
          const log = await memoryStore.appendConflictLog({
            status: "candidate",
            sourceL2Id: newL2Id,
            targetL2Id: existing.id,
            sourceRagId: newRagId,
            targetRagId: existing.ragId,
            reason: candidate.reason ?? "possible local lexical contradiction",
            confidence: candidate.confidence,
            detector: "local",
          })
          const score = scoreMemoryConflict({
            candidateSource: wasRecentlyInjectedMemory(existing.id) ? "recent_injection" : metadataMatch ? "rag" : "local",
            ragScore: metadataMatch ? matchedEntry.score : undefined,
            correctionIntent: hasCorrectionIntent(triggerText),
            recentInjection: wasRecentlyInjectedMemory(existing.id),
            localContradiction: true,
            evidence: await this.getEvidenceLevel(newL2Id, existing.id),
            activeTarget: existing.status !== "archived",
            impactScope: getImpactScope(existing),
          })
          await memoryStore.scoreConflictLog(log.id, score)
          console.log(`[MemoryManager] ⚠️ 發現疑似記憶衝突候選: "${preview(existing.content, 30)}" ↔ "${preview(content, 30)}"`)
        }
      }
    }
  }

  private async getEvidenceLevel(sourceL2Id: string, targetL2Id: string): Promise<ConflictEvidenceLevel> {
    const [sourceEvidence, targetEvidence] = await Promise.all([
      memoryStore.getEvidenceByMemoryId(sourceL2Id),
      memoryStore.getEvidenceByMemoryId(targetL2Id),
    ])
    if (sourceEvidence.length > 0 && targetEvidence.length > 0) return "both"
    if (sourceEvidence.length > 0 || targetEvidence.length > 0) return "one_side"
    return "none"
  }

  /**
   * 手動觸發的 L2 權重衰減。當前尚未掛載到生產調度；
   * 後續會由 memory-scheduler 統一決定觸發策略。
   */
  async runDecay(): Promise<void> {
    const changed = await memoryStore.decayL2Weights()
    console.log(`[MemoryManager] L2 權重衰減完成，更新 ${changed} 條`)
  }

  async onL2Recalled(ids: string[]): Promise<void> {
    void ids
  }
}

export const memoryManager = new MemoryManager()
