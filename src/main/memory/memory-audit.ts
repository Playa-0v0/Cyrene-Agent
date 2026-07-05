import * as fs from "fs"
import type { L2Memory, MemoryEvidence, MemoryStore } from "./memory-types"

export type MemoryAuditSeverity = "info" | "warning" | "error"

export interface MemoryAuditFinding {
  code:
    | "missing_evidence"
    | "empty_evidence_chain"
    | "absolute_overclaim"
    | "active_conflict_marker"
    | "stale_sync_status"
    | "broken_resolution_link"
  severity: MemoryAuditSeverity
  l2Id?: string
  message: string
  suggestion: string
  details?: Record<string, unknown>
}

export interface MemoryAuditReport {
  filePath: string
  findings: MemoryAuditFinding[]
}

export interface MemoryAuditSummary {
  total: number
  bySeverity: Record<MemoryAuditSeverity, number>
  byCode: Record<string, number>
}

const ABSOLUTE_TERMS = ["只", "永远", "从不", "一定", "完全", "绝对", "以后都", "不再"]

function hasEvidenceForTerm(term: string, evidence: MemoryEvidence[]): boolean {
  return evidence.some((item) => item.quoteSnippet.includes(term))
}

function evidenceForMemory(memory: L2Memory, evidenceById: Map<string, MemoryEvidence>): MemoryEvidence[] {
  return (memory.evidenceIds ?? [])
    .map((id) => evidenceById.get(id))
    .filter((item): item is MemoryEvidence => Boolean(item))
}

function hasMissingEvidence(memory: L2Memory, evidenceById: Map<string, MemoryEvidence>): boolean {
  return (memory.evidenceIds ?? []).some((id) => !evidenceById.has(id))
}

function addResolutionLinkFinding(findings: MemoryAuditFinding[], memory: L2Memory, field: "supersededBy" | "mergedInto"): void {
  findings.push({
    code: "broken_resolution_link",
    severity: "warning",
    l2Id: memory.id,
    message: `L2 ${memory.id} 的 ${field} 为空，历史解析链不完整。`,
    suggestion: "人工复核该条记忆是否应保持当前状态，或补齐/清理解析链路。",
    details: { status: memory.status, field },
  })
}

export function auditMemoryStore(store: MemoryStore): MemoryAuditFinding[] {
  const findings: MemoryAuditFinding[] = []
  const l2 = Array.isArray(store.l2) ? store.l2 : []
  const evidence = Array.isArray(store.evidence) ? store.evidence : []
  const evidenceById = new Map(evidence.map((item) => [item.id, item]))

  for (const memory of l2) {
    const linkedEvidence = evidenceForMemory(memory, evidenceById)

    if ((memory.evidenceIds?.length ?? 0) === 0) {
      findings.push({
        code: "empty_evidence_chain",
        severity: "warning",
        l2Id: memory.id,
        message: `L2 ${memory.id} 没有 evidenceIds，无法回看原始依据。`,
        suggestion: "把它列入人工复核清单；若内容无法追溯，建议降权或归档。",
      })
    } else if (hasMissingEvidence(memory, evidenceById)) {
      findings.push({
        code: "missing_evidence",
        severity: "error",
        l2Id: memory.id,
        message: `L2 ${memory.id} 引用了不存在的 evidenceId。`,
        suggestion: "检查 memory.json 历史迁移结果；缺失证据的高层记忆不要自动提升到核心画像。",
        details: { evidenceIds: memory.evidenceIds },
      })
    }

    const overclaimedTerms = ABSOLUTE_TERMS.filter((term) => (
      memory.content.includes(term) && !hasEvidenceForTerm(term, linkedEvidence)
    ))
    if (overclaimedTerms.length > 0) {
      findings.push({
        code: "absolute_overclaim",
        severity: "warning",
        l2Id: memory.id,
        message: `L2 ${memory.id} 含绝对化表达，但证据原文没有对应词。`,
        suggestion: "人工复核是否为模型推断过度；必要时改写为更窄、更有上下文的 L2。",
        details: { terms: overclaimedTerms },
      })
    }

    if ((memory.status === "active" || memory.status === "aging") && (memory.conflictWith?.length ?? 0) > 0) {
      findings.push({
        code: "active_conflict_marker",
        severity: "warning",
        l2Id: memory.id,
        message: `L2 ${memory.id} 仍为 ${memory.status}，但保留 conflictWith 标记。`,
        suggestion: "检查对应 conflict log 是否已 resolved；若已解析，清理旧冲突标记或调整状态。",
        details: { conflictWith: memory.conflictWith, status: memory.status },
      })
    }

    if (memory.syncStatus === "pending_sync" && !memory.ragId) {
      findings.push({
        code: "stale_sync_status",
        severity: "info",
        l2Id: memory.id,
        message: `L2 ${memory.id} 仍处于 pending_sync 且没有 ragId。`,
        suggestion: "下次启动同步任务时优先补偿；若内容已过期可直接归档。",
      })
    }

    if (memory.status === "superseded" && !memory.supersededBy) {
      addResolutionLinkFinding(findings, memory, "supersededBy")
    }
    if (memory.status === "merged" && !memory.mergedInto) {
      addResolutionLinkFinding(findings, memory, "mergedInto")
    }
  }

  return findings
}

export function summarizeMemoryAudit(findings: MemoryAuditFinding[]): MemoryAuditSummary {
  const summary: MemoryAuditSummary = {
    total: findings.length,
    bySeverity: { info: 0, warning: 0, error: 0 },
    byCode: {},
  }

  for (const finding of findings) {
    summary.bySeverity[finding.severity] += 1
    summary.byCode[finding.code] = (summary.byCode[finding.code] ?? 0) + 1
  }

  return summary
}

export function auditMemoryFile(filePath: string): MemoryAuditReport {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as MemoryStore
  return {
    filePath,
    findings: auditMemoryStore(parsed),
  }
}
