import { describe, expect, it } from "vitest"
import { findPossibleConflictCandidate } from "./memory-conflict"

describe("findPossibleConflictCandidate", () => {
  it("finds possible contradictions on the same concrete topic", () => {
    const candidate = findPossibleConflictCandidate("用户不喜欢香菇", "用户喜欢香菇")

    expect(candidate.isCandidate).toBe(true)
    expect(candidate.confidence).toBeLessThan(0.5)
  })

  it("does not mark unrelated negative experiences as candidates", () => {
    const candidate = findPossibleConflictCandidate(
      "用户对 AI 有强烈心意，因无法触碰而难过",
      "用户曾因食用见手青而有过不好经历",
    )

    expect(candidate.isCandidate).toBe(false)
  })

  it("requires a shared topic before applying contradiction pairs", () => {
    const candidate = findPossibleConflictCandidate("用户不喜欢香菇", "用户喜欢平菇")

    expect(candidate.isCandidate).toBe(false)
  })
})
