import { describe, expect, it } from "vitest"
import { findPossibleConflictCandidate } from "./memory-conflict"

describe("findPossibleConflictCandidate", () => {
  it("finds possible contradictions on the same concrete topic", () => {
    const candidate = findPossibleConflictCandidate("用戶不喜歡香菇", "用戶喜歡香菇")

    expect(candidate.isCandidate).toBe(true)
    expect(candidate.confidence).toBeLessThan(0.5)
  })

  it("does not mark unrelated negative experiences as candidates", () => {
    const candidate = findPossibleConflictCandidate(
      "用戶對 AI 有強烈心意，因無法觸碰而難過",
      "用戶曾因食用見手青而有過不好經歷",
    )

    expect(candidate.isCandidate).toBe(false)
  })

  it("requires a shared topic before applying contradiction pairs", () => {
    const candidate = findPossibleConflictCandidate("用戶不喜歡香菇", "用戶喜歡平菇")

    expect(candidate.isCandidate).toBe(false)
  })
})
