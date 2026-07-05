export interface L0Profile {
  nickname: string
  preferredName: string
  occupation: string
  longTermInterests: string
  language: string
  permanentNote: string
  isPinned: boolean
  updatedAt: number
}
export const L0_FIELD_DESCRIPTIONS: Partial<Record<keyof L0Profile, string>> = {
  preferredName:     '用户希望被如何称呼、叫什么名字、昵称。例如："叫我P宝""我叫Playa""以后喊我宝宝"',
  occupation:        '用户的职业、身份、工作。例如："我是前端工程师""我在做设计"',
  longTermInterests: '用户的长期兴趣爱好（稳定的，不是临时的）。例如："我一直喜欢画画""我从小学钢琴"',
  language:          '用户常用的语言或地区习惯。例如："我习惯说中文""我是广东人"',
  permanentNote:     '其他不属于以上四类的稳定个人信息。例如："我有一只猫""我住在上海"',
  // isPinned 和 updatedAt 不在这里，代表不暴露给 AI
}


export interface L1Profile {
  recentGoals: string
  recentPreferences: string
  currentProject: string
  generatedAt: number
  roundCount: number
}

export interface L2Memory {
  id: string
  content: string
  triggerText: string
  sourceConversationId: string
  createdAt: number
  lastAccessedAt: number
  accessCount: number
  weight: number
  isPinned: boolean
  status: "active" | "aging" | "archived"
  embedding?: number[]
  ragId?: string
  /** 是否为压缩总结条目（由 Reflection 生成） */
  isSummary?: boolean
  /** 被本条压缩的原始条目 id 列表 */
  subEntryIds?: string[]
  /** 冲突标记：与该记忆语义相矛盾的其他条目 ragId 列表 */
  conflictWith?: string[]
}

export interface ReflectionLog {
  id: string
  createdAt: number
  type: "compression" | "l0_update" | "l1_update" | "conflict_detected"
  summary: string
  details?: string
}

export interface MemoryCandidate {
  layer: "L0" | "L1" | "L2"
  field?: string
  content: string
  confidence: number
  triggerText: string
}

export interface MemoryStore {
  schemaVersion: number
  l0: L0Profile
  l1: L1Profile
  l2: L2Memory[]
  reflectionLogs?: ReflectionLog[]
  /** @deprecated Use schemaVersion for memory.json migrations. */
  version: number
}
