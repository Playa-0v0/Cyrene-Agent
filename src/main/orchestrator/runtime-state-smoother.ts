export type RuntimeFeelingName = "平静" | "开心" | "温柔" | "激动" | "撒娇" | "担心" | "难过" | "感动" | "害羞"

export type FeelingScores = Record<RuntimeFeelingName, number>

const FEELINGS: RuntimeFeelingName[] = ["平静", "开心", "温柔", "激动", "撒娇", "担心", "难过", "感动", "害羞"]
const FAST_RISE = new Set<RuntimeFeelingName>(["担心", "难过"])

export function createFeelingScores(initial: RuntimeFeelingName = "平静"): FeelingScores {
  const scores = Object.fromEntries(FEELINGS.map((feeling) => [feeling, 0])) as FeelingScores
  scores[initial] = 1
  return scores
}

export function smoothFeeling(
  current: FeelingScores,
  observed: string,
): { feeling: RuntimeFeelingName; scores: FeelingScores } {
  const next = { ...current }
  const target = FEELINGS.includes(observed as RuntimeFeelingName)
    ? observed as RuntimeFeelingName
    : "平静"
  const observedWeight = FAST_RISE.has(target) ? 0.62 : 0.3
  const decay = 1 - observedWeight

  for (const feeling of FEELINGS) {
    next[feeling] = (next[feeling] ?? 0) * decay
  }
  next[target] = (next[target] ?? 0) + observedWeight

  let best: RuntimeFeelingName = "平静"
  for (const feeling of FEELINGS) {
    if (next[feeling] > next[best]) best = feeling
  }

  return { feeling: best, scores: next }
}
