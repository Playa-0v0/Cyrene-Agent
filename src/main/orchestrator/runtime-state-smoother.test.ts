import { describe, expect, it } from "vitest"
import { createFeelingScores, smoothFeeling } from "./runtime-state-smoother"

describe("runtime-state-smoother", () => {
  it("keeps one mild observation from abruptly flipping the visible feeling", () => {
    const scores = createFeelingScores("平靜")

    const next = smoothFeeling(scores, "開心")

    expect(next.feeling).toBe("平靜")
    expect(next.scores["開心"]).toBeGreaterThan(0)
  })

  it("changes feeling after repeated consistent observations", () => {
    let state = createFeelingScores("平靜")

    state = smoothFeeling(state, "開心").scores
    state = smoothFeeling(state, "開心").scores
    const next = smoothFeeling(state, "開心")

    expect(next.feeling).toBe("開心")
  })

  it("lets concern rise faster than casual mood changes", () => {
    const scores = createFeelingScores("平靜")

    const next = smoothFeeling(scores, "擔心")

    expect(next.feeling).toBe("擔心")
  })
})
