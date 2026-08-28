import * as fs from "fs"
import * as path from "path"
import type { ConversationMemorySummary } from "./conversation-summary-types"

const SUMMARIES_SUBDIR = "summaries"

export class ConversationSummaryStore {
  private readonly summariesDir: string

  constructor(chatsRootDir: string) {
    this.summariesDir = path.join(chatsRootDir, SUMMARIES_SUBDIR)
  }

  get(sessionId: string): ConversationMemorySummary | null {
    const filePath = this.summaryPath(sessionId)
    if (!fs.existsSync(filePath)) return null
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Omit<ConversationMemorySummary, "schemaVersion"> & {
        schemaVersion: number
        currentState?: string[]
        nextSteps?: string[]
      }
      if ((value?.schemaVersion !== 1 && value?.schemaVersion !== 2) || value.sessionId !== sessionId) return null
      return {
        ...value,
        schemaVersion: 2,
        currentState: stringArray(value.currentState),
        nextSteps: stringArray(value.nextSteps),
      }
    } catch (error) {
      console.warn("[ConversationSummaryStore] 摘要文件解析失败:", sessionId, error)
      return null
    }
  }

  put(summary: ConversationMemorySummary): void {
    this.ensureDir()
    const filePath = this.summaryPath(summary.sessionId)
    const tmpPath = `${filePath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2), "utf8")
    fs.renameSync(tmpPath, filePath)
  }

  delete(sessionId: string): boolean {
    const filePath = this.summaryPath(sessionId)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)
    return true
  }

  list(): ConversationMemorySummary[] {
    if (!fs.existsSync(this.summariesDir)) return []
    const summaries: ConversationMemorySummary[] = []
    for (const file of fs.readdirSync(this.summariesDir)) {
      if (!file.endsWith(".json")) continue
      const sessionId = file.slice(0, -5)
      const summary = this.get(sessionId)
      if (summary) summaries.push(summary)
    }
    return summaries
  }

  private ensureDir(): void {
    fs.mkdirSync(this.summariesDir, { recursive: true })
  }

  private summaryPath(sessionId: string): string {
    if (!sessionId || path.basename(sessionId) !== sessionId || /[<>:"/\\|?*]/.test(sessionId)) {
      throw new Error("invalid conversation summary sessionId")
    }
    return path.join(this.summariesDir, `${sessionId}.json`)
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
}
