import { memoryStore } from "./memory-store"
import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, L2Memory } from "./memory-types"
import { addMemory, searchMemory } from "../rag/index"

type L1Field = "recentGoals" | "recentPreferences"

/** 语义矛盾关键词对：前面的词表示正面/肯定，对应后面的是负面/否定 */
const CONTRADICTION_PAIRS: Array<[string, string[]]> = [
  ["喜欢", ["不喜欢", "讨厌", "反感", "厌恶", "不再喜欢"]],
  ["爱", ["不爱", "讨厌", "恨"]],
  ["想", ["不想", "别想", "不愿"]],
  ["要", ["不要", "别要"]],
  ["是", ["不是", "并非"]],
  ["可以", ["不可以", "不行", "不能"]],
  ["会", ["不会"]],
  ["有", ["没有", "没了", "无"]],
  ["好", ["不好", "坏", "差"]],
  ["开心", ["不开心", "难过", "伤心", "郁闷"]],
  ["忙", ["不忙", "闲"]],
]

/** 检测两条文本是否语义矛盾 */
function isContradictory(textA: string, textB: string): boolean {
  const a = textA.toLowerCase()
  const b = textB.toLowerCase()
  for (const [positive, negatives] of CONTRADICTION_PAIRS) {
    const aHasPos = a.includes(positive)
    const bHasPos = b.includes(positive)
    const aHasNeg = negatives.some((n) => a.includes(n))
    const bHasNeg = negatives.some((n) => b.includes(n))
    // 一条里正面 + 另一条里对应负面 = 矛盾
    if ((aHasPos && bHasNeg) || (bHasPos && aHasNeg)) return true
  }
  return false
}

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
    await memoryStore.updateL0({ permanentNote: updated })
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
        await memoryStore.updateL0({ [candidate.field]: candidate.content })
        console.log(`[MemoryManager] L0 更新字段: ${candidate.field} = "${candidate.content.slice(0, 20)}"`)
      } else if (candidate.layer === "L1") {
        const field = getL1Field(candidate.content)
        await memoryStore.updateL1({ [field]: candidate.content })
        console.log(`[MemoryManager] L1 更新字段: ${field}`)
      } else if (candidate.layer === "L2") {
        await this.writeL2(candidate)
      }
    }
  }

  private async writeL2(candidate: MemoryCandidate): Promise<void> {
    const ragId = await addMemory(candidate.content, "user_memory", {
      triggerText: candidate.triggerText,
      confidence: candidate.confidence,
    })

    const l2Input: Omit<L2Memory, "id" | "createdAt" | "lastAccessedAt" | "accessCount" | "weight" | "status"> = {
      content: candidate.content,
      triggerText: candidate.triggerText,
      sourceConversationId: "",
      ragId,
      embedding: [],
      isPinned: false,
    }

    await memoryStore.addL2(l2Input)

    console.log(`[MemoryManager] L2 写入: "${preview(candidate.content, 30)}"（ragId: ${ragId}）`)

    // ── 冲突检测：检查新记忆是否与现有记忆矛盾 ──
    try {
      await this.detectAndMarkConflicts(candidate.content, ragId)
    } catch (err) {
      console.warn("[MemoryManager] 冲突检测失败:", err)
    }
  }

  /** 检测新记忆是否与现有 active 记忆矛盾，如有则标记 */
  private async detectAndMarkConflicts(content: string, newRagId: string): Promise<void> {
    // 搜索语义相似的现有 L2 条目
    const allL2 = await memoryStore.getAllL2()
    const activeL2 = allL2.filter((m) => m.status !== "archived" && m.ragId && m.ragId !== newRagId)

    // 用 searchMemory 做向量相似度匹配
    const similarTexts = await searchMemory(content, "user_memory", 5)
    if (similarTexts.length === 0) return

    // 在 activeL2 中找内容匹配的，再检查是否语义矛盾
    for (const existing of activeL2) {
      const isSimilar = similarTexts.some((st) => st === existing.content || existing.content.includes(st.slice(0, 20)))
      if (!isSimilar) continue

      if (isContradictory(content, existing.content)) {
        // 检测到矛盾：在现有条目上标记
        const marked = await memoryStore.markL2Conflict(existing.id, newRagId)
        if (marked) {
          console.log(`[MemoryManager] ⚠️ 检测到记忆冲突: "${preview(existing.content, 30)}" ↔ "${preview(content, 30)}"`)
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
