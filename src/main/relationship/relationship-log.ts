import * as fs from "fs"
import * as path from "path"
import { app } from "electron"

export type RelationshipChannel = "desktop" | "wechat" | "feishu" | "qq"

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
  if (/累|疲惫|困|没精神|撑不住|倦/.test(text)) return "疲惫"
  if (/不要|别|不想|不喜欢|太影响|影响观感|先不|别.*问|不要.*确认/.test(text)) return "明确边界"
  if (/焦虑|压力|烦|崩|紧张|担心|慌/.test(text)) return "焦虑"
  if (/难过|伤心|委屈|失落|想哭/.test(text)) return "低落"
  if (/开心|高兴|舒服|喜欢|好耶|太好了/.test(text)) return "开心"
  return "未知"
}

function deriveSignal(userText: string, userMood: string): {
  relationshipSignal: string
  importantMoment?: string
  nextCareCue: string
} {
  if (userMood === "明确边界") {
    return {
      relationshipSignal: "用户表达了低打扰偏好或体验边界，需要优先尊重，不要把关心做成打断。",
      importantMoment: "用户明确表示不喜欢影响观感的确认卡片或过度询问。",
      nextCareCue: "不要弹确认或反复追问；先按用户偏好安静执行，必要时用一句话确认。",
    }
  }

  if (userMood === "疲惫") {
    return {
      relationshipSignal: "用户显露疲惫状态，更需要低压力陪伴和短回应。",
      nextCareCue: "下次回应提示：少安排、少追问，语气放慢，先接住状态。",
    }
  }

  if (userMood === "焦虑") {
    return {
      relationshipSignal: "用户可能处在压力或焦虑里，需要稳定感和清晰的小步建议。",
      nextCareCue: "下次回应提示：先安抚，再给一两个可执行小步，不要铺太大。",
    }
  }

  if (userMood === "低落") {
    return {
      relationshipSignal: "用户情绪偏低，需要被理解和陪着，而不是立刻被纠正。",
      nextCareCue: "下次回应提示：先承认感受，再轻轻陪伴，不要急着总结道理。",
    }
  }

  if (userMood === "开心") {
    return {
      relationshipSignal: "用户反馈偏积极，可以保持轻快互动并记住触发愉快的点。",
      nextCareCue: "下次回应提示：可以更轻松一点，延续用户的好状态。",
    }
  }

  return {
    relationshipSignal: "本轮互动没有明显情绪峰值，保持自然陪伴即可。",
    nextCareCue: `下次回应提示：延续最近话题「${compact(userText, 40)}」，不要过度解读。`,
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
  const dominantMood = moods.at(-1) ?? "平稳"
  const important = [...entries].reverse().find((e) => e.importantMoment)?.importantMoment
  const cue = entries.at(-1)?.nextCareCue ?? "保持自然陪伴。"
  const signal = entries.at(-1)?.relationshipSignal ?? "今天互动平稳。"
  const parts = [
    `${date}：用户最近状态偏「${dominantMood}」。`,
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

    const lastMood = [...recent].reverse().find((e) => e.userMood !== "未知")?.userMood ?? "平稳"
    const latestSummary = data.dailySummaries.at(-1)?.summary
    const preference = [...recent].reverse().find((e) => e.importantMoment)?.importantMoment
    const cues = [...new Set(recent.map((e) => e.nextCareCue).filter(Boolean))].slice(-3)

    const lines = [
      "【近期关系线索】",
      `- 用户最近状态：${lastMood}`,
    ]
    if (latestSummary) lines.push(`- 最近日记摘要：${latestSummary}`)
    if (preference) lines.push(`- 重要互动偏好：${preference}`)
    if (cues.length > 0) lines.push(`- 下次回应提示：${cues.join("；")}`)
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
