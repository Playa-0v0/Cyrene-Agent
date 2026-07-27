export type RuntimeFeelingName = "平靜" | "開心" | "溫柔" | "激動" | "撒嬌" | "擔心" | "難過" | "感動" | "害羞"

export type FeelingScores = Record<RuntimeFeelingName, number>

const FEELINGS: RuntimeFeelingName[] = ["平靜", "開心", "溫柔", "激動", "撒嬌", "擔心", "難過", "感動", "害羞"]
const FAST_RISE = new Set<RuntimeFeelingName>(["擔心", "難過"])

export function createFeelingScores(initial: RuntimeFeelingName = "平靜"): FeelingScores {
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
    : "平靜"
  const observedWeight = FAST_RISE.has(target) ? 0.62 : 0.3
  const decay = 1 - observedWeight

  for (const feeling of FEELINGS) {
    next[feeling] = (next[feeling] ?? 0) * decay
  }
  next[target] = (next[target] ?? 0) + observedWeight

  let best: RuntimeFeelingName = "平靜"
  for (const feeling of FEELINGS) {
    if (next[feeling] > next[best]) best = feeling
  }

  return { feeling: best, scores: next }
}
