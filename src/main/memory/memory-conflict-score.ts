import type { ConflictResolverPriority, ConflictScoringSignals } from "./memory-types"

export type ConflictCandidateSource = "local" | "rag" | "recent_injection"
export type ConflictEvidenceLevel = "none" | "one_side" | "both"

export interface ConflictScoreInput {
  candidateSource: ConflictCandidateSource
  ragScore?: number
  correctionIntent?: boolean
  recentInjection?: boolean
  localContradiction?: boolean
  evidence: ConflictEvidenceLevel
  activeTarget: boolean
  impactScope?: "low" | "medium" | "high"
  recentlyResolvedSamePair?: boolean
}

export interface ConflictScoreResult {
  conflictScore: number
  resolverPriority: ConflictResolverPriority
  scoringSignals: ConflictScoringSignals
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)))
}

function priorityFor(score: number): ConflictResolverPriority {
  if (score >= 75) return "high"
  if (score >= 55) return "normal"
  if (score >= 35) return "idle"
  return "none"
}

function ragPoints(score: number | undefined): number {
  if (score === undefined) return 0
  if (score >= 0.75) return 25
  if (score >= 0.45) return 18
  return 10
}

function evidencePoints(evidence: ConflictEvidenceLevel): number {
  if (evidence === "both") return 15
  if (evidence === "one_side") return 8
  return 0
}

function impactPoints(scope: ConflictScoreInput["impactScope"]): number {
  if (scope === "high") return 10
  if (scope === "medium") return 6
  if (scope === "low") return 3
  return 0
}

export function scoreMemoryConflict(input: ConflictScoreInput): ConflictScoreResult {
  const penalties: string[] = []
  let score = 0

  const ragCandidate = input.candidateSource === "rag"
  const recentInjection = input.candidateSource === "recent_injection" || input.recentInjection === true

  if (input.correctionIntent) score += 20
  if (ragCandidate) score += ragPoints(input.ragScore)
  if (recentInjection) score += 20
  score += evidencePoints(input.evidence)
  if (input.localContradiction) score += 10
  score += impactPoints(input.impactScope)

  if (!input.activeTarget) {
    score -= 25
    penalties.push("archived_only_target")
  }
  if (input.evidence === "none") {
    score -= 20
    penalties.push("missing_evidence")
  }
  if (input.recentlyResolvedSamePair) {
    score -= 25
    penalties.push("recently_resolved_same_pair")
  }

  const conflictScore = clampScore(score)
  let resolverPriority = priorityFor(conflictScore)

  if (input.candidateSource === "local" || !input.activeTarget || input.evidence === "none") {
    resolverPriority = "none"
  }

  const scoringSignals: ConflictScoringSignals = {
    correctionIntent: input.correctionIntent === true,
    ragCandidate,
    recentInjection,
    evidenceAvailable: input.evidence !== "none",
    localContradiction: input.localContradiction === true,
    impactScope: input.impactScope ?? "low",
    penalties,
  }

  return {
    conflictScore,
    resolverPriority,
    scoringSignals,
  }
}
