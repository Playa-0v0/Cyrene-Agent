import { memoryStore } from "./memory-store"
import type { L0WritableField } from "./memory-store"
import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, L2Memory } from "./memory-types"
import { findPossibleConflictCandidate } from "./memory-conflict"
import { addMemory, searchMemory } from "../rag/index"

type L1Field = "recentGoals" | "recentPreferences"

function preview(content: string, maxLength: number): string {
  return content.slice(0, maxLength)
}

function getL1Field(content: string): L1Field {
  if (/目标|想要|计划|打算/.test(content)) return "recentGoals"
  return "recentPreferences"
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
      if (candidate.layer === "L0") {
        // 如果 L0 被用户锁定，跳过
        const l0 = await memoryStore.getL0()
        if (l0.isPinned) {
          console.log("[MemoryManager] L0 已锁定，跳过自动更新")
          continue
        }

        // 从唯一事实来源获取合法字段列表
        const validFields = Object.keys(L0_FIELD_DESCRIPTIONS)

        // 情况一：AI 没有输出 field 字段（理论上不该发生）
        if (!candidate.field) {
          console.warn("[MemoryManager] L0 候选缺少 field 字段，降级追加到 permanentNote")
          await this.appendToPermanentNote(candidate.content)
          continue
        }

        // 情况二：AI 输出了非法字段名（幻觉）
        if (!validFields.includes(candidate.field)) {
          console.warn(`[MemoryManager] AI 返回非法字段 "${candidate.field}"，降级追加到 permanentNote`)
          await this.appendToPermanentNote(candidate.content)
          continue
        }

        // 情况三：合法字段，直接写入
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
      console.warn("[MemoryManager] L2 已写入，但 RAG 同步失败:", err)
      return
    }

    console.log(`[MemoryManager] L2 写入: "${preview(candidate.content, 30)}"（l2Id: ${l2.id}, ragId: ${ragId}）`)

    // ── 冲突检测：检查新记忆是否与现有记忆矛盾 ──
    try {
      await this.detectAndMarkConflicts(candidate.content, l2.id, ragId)
    } catch (err) {
      console.warn("[MemoryManager] 冲突检测失败:", err)
    }
  }

  /** 检测新记忆是否与现有 active 记忆矛盾，如有则标记 */
  private async detectAndMarkConflicts(content: string, newL2Id: string, newRagId: string): Promise<void> {
    // 搜索语义相似的现有 L2 条目
    const allL2 = await memoryStore.getAllL2()
    const activeL2 = allL2.filter((m) => m.status !== "archived" && m.ragId && m.ragId !== newRagId)

    // 用 searchMemory 做向量相似度匹配
    const similarTexts = await searchMemory(content, "user_memory", 5, { recordRecall: false })
    if (similarTexts.length === 0) return

    // 在 activeL2 中找内容匹配的，再检查是否语义矛盾
    for (const existing of activeL2) {
      const isSimilar = similarTexts.some((st) => st === existing.content || existing.content.includes(st.slice(0, 20)))
      if (!isSimilar) continue

      const candidate = findPossibleConflictCandidate(content, existing.content)
      if (candidate.isCandidate) {
        // 本地规则只产出疑似候选，不确认冲突真伪。
        const marked = await memoryStore.markL2Conflict(existing.id, newRagId)
        if (marked) {
          await memoryStore.appendConflictLog({
            status: "candidate",
            sourceL2Id: newL2Id,
            targetL2Id: existing.id,
            sourceRagId: newRagId,
            targetRagId: existing.ragId,
            reason: candidate.reason ?? "possible local lexical contradiction",
            confidence: candidate.confidence,
            detector: "local",
          })
          console.log(`[MemoryManager] ⚠️ 发现疑似记忆冲突候选: "${preview(existing.content, 30)}" ↔ "${preview(content, 30)}"`)
        }
      }
    }
  }

  /**
   * 手动触发的 L2 权重衰减。当前尚未挂载到生产调度；
   * 后续会由 memory-scheduler 统一决定触发策略。
   */
  async runDecay(): Promise<void> {
    const changed = await memoryStore.decayL2Weights()
    console.log(`[MemoryManager] L2 权重衰减完成，更新 ${changed} 条`)
  }

  async onL2Recalled(ids: string[]): Promise<void> {
    void ids
  }
}

export const memoryManager = new MemoryManager()
