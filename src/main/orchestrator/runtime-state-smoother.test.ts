import { describe, expect, it } from "vitest"
import { createFeelingScores, smoothFeeling } from "./runtime-state-smoother"

describe("runtime-state-smoother", () => {
  it("keeps one mild observation from abruptly flipping the visible feeling", () => {
    const scores = createFeelingScores("平静")

    const next = smoothFeeling(scores, "开心")

    expect(next.feeling).toBe("平静")
    expect(next.scores["开心"]).toBeGreaterThan(0)
  })

  it("changes feeling after repeated consistent observations", () => {
    let state = createFeelingScores("平静")

    state = smoothFeeling(state, "开心").scores
    state = smoothFeeling(state, "开心").scores
    const next = smoothFeeling(state, "开心")

    expect(next.feeling).toBe("开心")
  })

  it("lets concern rise faster than casual mood changes", () => {
    const scores = createFeelingScores("平静")

    const next = smoothFeeling(scores, "担心")

    expect(next.feeling).toBe("担心")
  })
})
