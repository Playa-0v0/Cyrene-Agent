import { describe, expect, it } from "vitest"
import { scoreMemoryConflict } from "./memory-conflict-score"

describe("scoreMemoryConflict", () => {
  it("keeps local-only candidates below resolver eligibility", () => {
    const result = scoreMemoryConflict({
      candidateSource: "local",
      localContradiction: true,
      evidence: "both",
      activeTarget: true,
    })

    expect(result.conflictScore).toBeLessThan(35)
    expect(result.resolverPriority).toBe("none")
    expect(result.scoringSignals.ragCandidate).toBe(false)
    expect(result.scoringSignals.localContradiction).toBe(true)
  })

  it("makes RAG-backed candidates with evidence idle eligible", () => {
    const result = scoreMemoryConflict({
      candidateSource: "rag",
      ragScore: 0.8,
      localContradiction: true,
      evidence: "both",
      activeTarget: true,
    })

    expect(result.conflictScore).toBeGreaterThanOrEqual(35)
    expect(result.resolverPriority).toBe("idle")
    expect(result.scoringSignals.ragCandidate).toBe(true)
    expect(result.scoringSignals.evidenceAvailable).toBe(true)
  })

  it("raises explicit corrections to normal priority when RAG locates a target", () => {
    const result = scoreMemoryConflict({
      candidateSource: "rag",
      ragScore: 0.85,
      correctionIntent: true,
      localContradiction: true,
      evidence: "both",
      activeTarget: true,
    })

    expect(result.conflictScore).toBeGreaterThanOrEqual(55)
    expect(result.resolverPriority).toBe("normal")
    expect(result.scoringSignals.correctionIntent).toBe(true)
  })

  it("raises recent injected corrections to high priority", () => {
    const result = scoreMemoryConflict({
      candidateSource: "rag",
      ragScore: 0.9,
      correctionIntent: true,
      recentInjection: true,
      localContradiction: true,
      evidence: "both",
      activeTarget: true,
    })

    expect(result.conflictScore).toBeGreaterThanOrEqual(75)
    expect(result.resolverPriority).toBe("high")
    expect(result.scoringSignals.recentInjection).toBe(true)
  })

  it("penalizes inactive evidence-less pairs below eligibility", () => {
    const result = scoreMemoryConflict({
      candidateSource: "rag",
      ragScore: 0.9,
      evidence: "none",
      activeTarget: false,
    })

    expect(result.resolverPriority).toBe("none")
    expect(result.scoringSignals.penalties).toEqual(expect.arrayContaining(["archived_only_target", "missing_evidence"]))
  })
})
