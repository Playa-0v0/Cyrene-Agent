export interface PossibleConflictCandidate {
  isCandidate: boolean
  reason?: string
  confidence: number
}

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
  ["忙", ["不忙", "闲"]],
]

const STOP_TERMS = new Set([
  "用户",
  "一个",
  "一种",
  "这个",
  "那个",
  "自己",
  "因为",
  "所以",
  "但是",
  "没有",
  "不是",
  "不会",
  "不能",
  "不喜",
  "喜欢",
  "讨厌",
  "反感",
  "厌恶",
  "不爱",
  "不想",
  "不要",
  "不是",
  "不行",
  "不会",
  "没有",
  "没了",
  "不忙",
])

function normalize(text: string): string {
  return text.toLowerCase()
}

function extractTopicTerms(text: string): Set<string> {
  const terms = new Set<string>()
  const matches = text.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z0-9]{3,}/g) ?? []
  for (const raw of matches) {
    const term = raw.toLowerCase()
    if (STOP_TERMS.has(term)) continue
    terms.add(term)
    if (/^[\u4e00-\u9fff]+$/.test(term) && term.length > 2) {
      for (let i = 0; i <= term.length - 2; i++) {
        const gram = term.slice(i, i + 2)
        if (!STOP_TERMS.has(gram)) terms.add(gram)
      }
    }
  }
  return terms
}

function hasSharedTopic(textA: string, textB: string): boolean {
  const aTerms = extractTopicTerms(textA)
  const bTerms = extractTopicTerms(textB)
  for (const term of aTerms) {
    if (bTerms.has(term)) return true
  }
  return false
}

export function findPossibleConflictCandidate(newContent: string, existingContent: string): PossibleConflictCandidate {
  if (!hasSharedTopic(newContent, existingContent)) {
    return { isCandidate: false, confidence: 0 }
  }

  const a = normalize(newContent)
  const b = normalize(existingContent)
  for (const [positive, negatives] of CONTRADICTION_PAIRS) {
    const aHasPos = a.includes(positive)
    const bHasPos = b.includes(positive)
    const aHasNeg = negatives.some((n) => a.includes(n))
    const bHasNeg = negatives.some((n) => b.includes(n))
    if ((aHasPos && bHasNeg) || (bHasPos && aHasNeg)) {
      return {
        isCandidate: true,
        reason: `possible shared-topic lexical contradiction: ${positive}`,
        confidence: 0.35,
      }
    }
  }

  return { isCandidate: false, confidence: 0 }
}
