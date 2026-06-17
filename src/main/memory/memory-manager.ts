import { memoryStore } from "./memory-store"
import { MemoryCandidate, L0_FIELD_DESCRIPTIONS, L2Memory } from "./memory-types"
import { addMemory } from "../rag/index"

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
  }

  async runDecay(): Promise<void> {
    console.log("[MemoryManager] 权重衰减由 RAG 系统自动处理，跳过")
  }

  async onL2Recalled(ids: string[]): Promise<void> {
    void ids
  }
}

export const memoryManager = new MemoryManager()
