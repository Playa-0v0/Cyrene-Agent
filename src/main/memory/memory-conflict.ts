export interface PossibleConflictCandidate {
  isCandidate: boolean
  reason?: string
  confidence: number
}

/** 語義矛盾關鍵詞對：前面的詞表示正面/肯定，對應後面的是負面/否定 */
const CONTRADICTION_PAIRS: Array<[string, string[]]> = [
  ["喜歡", ["不喜歡", "討厭", "反感", "厭惡", "不再喜歡"]],
  ["愛", ["不愛", "討厭", "恨"]],
  ["想", ["不想", "別想", "不願"]],
  ["要", ["不要", "別要"]],
  ["是", ["不是", "並非"]],
  ["可以", ["不可以", "不行", "不能"]],
  ["會", ["不會"]],
  ["有", ["沒有", "沒了", "無"]],
  ["忙", ["不忙", "閒"]],
]

const STOP_TERMS = new Set([
  "用戶",
  "一個",
  "一種",
  "這個",
  "那個",
  "自己",
  "因為",
  "所以",
  "但是",
  "沒有",
  "不是",
  "不會",
  "不能",
  "不喜",
  "喜歡",
  "討厭",
  "反感",
  "厭惡",
  "不愛",
  "不想",
  "不要",
  "不是",
  "不行",
  "不會",
  "沒有",
  "沒了",
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
