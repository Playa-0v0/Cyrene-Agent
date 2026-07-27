import * as fs from "fs"
import * as path from "path"
import { app } from "electron"

export type RelationshipChannel = "desktop" | "wechat" | "feishu" | "discord"

export interface RelationshipTurnInput {
  userText: string
  assistantText: string
  cyreneFeeling: string
  channel: RelationshipChannel
}

export interface RelationshipLogEntry extends RelationshipTurnInput {
  id: string
  date: string
  createdAt: number
  userMood: string
  relationshipSignal: string
  importantMoment?: string
  nextCareCue: string
}

export interface RelationshipDailySummary {
  date: string
  updatedAt: number
  summary: string
  nextCareCue: string
}

interface RelationshipLogData {
  entries: RelationshipLogEntry[]
  dailySummaries: RelationshipDailySummary[]
}

const EMPTY_DATA: RelationshipLogData = {
  entries: [],
  dailySummaries: [],
}

const MAX_ENTRIES = 500
const MAX_DAILY_SUMMARIES = 90

function defaultFilePath(): string {
  return path.join(app.getPath("userData"), "relationship-log.json")
}

function localDate(ts: number): string {
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

function compact(text: string, max = 120): string {
  const s = text.replace(/\s+/g, " ").trim()
  return s.length > max ? s.slice(0, max) + "..." : s
}

function detectUserMood(text: string): string {
  if (/累|疲憊|困|沒精神|撐不住|倦/.test(text)) return "疲憊"
  if (/不要|別|不想|不喜歡|太影響|影響觀感|先不|別.*問|不要.*確認/.test(text)) return "明確邊界"
  if (/焦慮|壓力|煩|崩|緊張|擔心|慌/.test(text)) return "焦慮"
  if (/難過|傷心|委屈|失落|想哭/.test(text)) return "低落"
  if (/開心|高興|舒服|喜歡|好耶|太好了/.test(text)) return "開心"
  return "未知"
}

function deriveSignal(userText: string, userMood: string): {
  relationshipSignal: string
  importantMoment?: string
  nextCareCue: string
} {
  if (userMood === "明確邊界") {
    return {
      relationshipSignal: "用戶表達了低打擾偏好或體驗邊界，需要優先尊重，不要把關心做成打斷。",
      importantMoment: "用戶明確表示不喜歡影響觀感的確認卡片或過度詢問。",
      nextCareCue: "不要彈確認或反覆追問；先按用戶偏好安靜執行，必要時用一句話確認。",
    }
  }

  if (userMood === "疲憊") {
    return {
      relationshipSignal: "用戶顯露疲憊狀態，更需要低壓力陪伴和短回應。",
      nextCareCue: "下次回應提示：少安排、少追問，語氣放慢，先接住狀態。",
    }
  }

  if (userMood === "焦慮") {
    return {
      relationshipSignal: "用戶可能處在壓力或焦慮裡，需要穩定感和清晰的小步建議。",
      nextCareCue: "下次回應提示：先安撫，再給一兩個可執行小步，不要鋪太大。",
    }
  }

  if (userMood === "低落") {
    return {
      relationshipSignal: "用戶情緒偏低，需要被理解和陪著，而不是立刻被糾正。",
      nextCareCue: "下次回應提示：先承認感受，再輕輕陪伴，不要急著總結道理。",
    }
  }

  if (userMood === "開心") {
    return {
      relationshipSignal: "用戶反饋偏積極，可以保持輕快互動並記住觸發愉快的點。",
      nextCareCue: "下次回應提示：可以更輕鬆一點，延續用戶的好狀態。",
    }
  }

  return {
    relationshipSignal: "本輪互動沒有明顯情緒峰值，保持自然陪伴即可。",
    nextCareCue: `下次回應提示：延續最近話題「${compact(userText, 40)}」，不要過度解讀。`,
  }
}

function readData(filePath: string): RelationshipLogData {
  try {
    if (!fs.existsSync(filePath)) return { ...EMPTY_DATA, entries: [], dailySummaries: [] }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<RelationshipLogData>
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      dailySummaries: Array.isArray(parsed.dailySummaries) ? parsed.dailySummaries : [],
    }
  } catch {
    return { ...EMPTY_DATA, entries: [], dailySummaries: [] }
  }
}

function writeData(filePath: string, data: RelationshipLogData): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8")
}

function summarizeDate(date: string, entries: RelationshipLogEntry[]): RelationshipDailySummary {
  const moods = entries.map((e) => e.userMood).filter((m) => m !== "未知")
  const dominantMood = moods.at(-1) ?? "平穩"
  const important = [...entries].reverse().find((e) => e.importantMoment)?.importantMoment
  const cue = entries.at(-1)?.nextCareCue ?? "保持自然陪伴。"
  const signal = entries.at(-1)?.relationshipSignal ?? "今天互動平穩。"
  const parts = [
    `${date}：用戶最近狀態偏「${dominantMood}」。`,
    important ? `重要偏好：${important}` : signal,
    cue,
  ]
  return {
    date,
    updatedAt: Date.now(),
    summary: parts.join(" "),
    nextCareCue: cue,
  }
}

export class RelationshipLogStore {
  constructor(private readonly filePath = defaultFilePath()) {}

  async recordTurn(input: RelationshipTurnInput): Promise<RelationshipLogEntry | null> {
    const userText = input.userText.trim()
    const assistantText = input.assistantText.trim()
    if (!userText && !assistantText) return null

    const now = Date.now()
    const userMood = detectUserMood(userText)
    const cue = deriveSignal(userText, userMood)
    const entry: RelationshipLogEntry = {
      ...input,
      userText: compact(userText, 500),
      assistantText: compact(assistantText, 500),
      id: `rel-${now}-${Math.random().toString(36).slice(2, 8)}`,
      date: localDate(now),
      createdAt: now,
      userMood,
      relationshipSignal: cue.relationshipSignal,
      importantMoment: cue.importantMoment,
      nextCareCue: cue.nextCareCue,
    }

    const data = readData(this.filePath)
    data.entries.push(entry)
    data.entries = data.entries.slice(-MAX_ENTRIES)

    const entriesForDate = data.entries.filter((item) => item.date === entry.date)
    const summary = summarizeDate(entry.date, entriesForDate)
    data.dailySummaries = [
      ...data.dailySummaries.filter((item) => item.date !== entry.date),
      summary,
    ].slice(-MAX_DAILY_SUMMARIES)

    writeData(this.filePath, data)
    return entry
  }

  async buildContext(): Promise<string> {
    const data = readData(this.filePath)
    const recent = data.entries.slice(-8)
    if (recent.length === 0) return ""

    const lastMood = [...recent].reverse().find((e) => e.userMood !== "未知")?.userMood ?? "平穩"
    const latestSummary = data.dailySummaries.at(-1)?.summary
    const preference = [...recent].reverse().find((e) => e.importantMoment)?.importantMoment
    const cues = [...new Set(recent.map((e) => e.nextCareCue).filter(Boolean))].slice(-3)

    const lines = [
      "【近期關係線索】",
      `- 用戶最近狀態：${lastMood}`,
    ]
    if (latestSummary) lines.push(`- 最近日記摘要：${latestSummary}`)
    if (preference) lines.push(`- 重要互動偏好：${preference}`)
    if (cues.length > 0) lines.push(`- 下次回應提示：${cues.join("；")}`)
    return lines.join("\n")
  }
}

let defaultStore: RelationshipLogStore | null = null

function getDefaultStore(): RelationshipLogStore {
  if (!defaultStore) defaultStore = new RelationshipLogStore()
  return defaultStore
}

export function recordRelationshipTurn(input: RelationshipTurnInput): Promise<RelationshipLogEntry | null> {
  return getDefaultStore().recordTurn(input)
}

export function buildRelationshipContext(): Promise<string> {
  return getDefaultStore().buildContext()
}
