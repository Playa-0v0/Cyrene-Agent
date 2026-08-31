import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import type { MemoryStore } from "./memory-types"
import { auditMemoryFile, auditMemoryStore, summarizeMemoryAudit } from "./memory-audit"

function baseStore(patch: Partial<MemoryStore> = {}): MemoryStore {
  return {
    schemaVersion: 2,
    l0: {
      nickname: "",
      preferredName: "",
      occupation: "",
      longTermInterests: "",
      language: "zh-CN",
      permanentNote: "",
      isPinned: false,
      updatedAt: 0,
    },
    l1: {
      recentGoals: "",
      recentPreferences: "",
      currentProject: "",
      generatedAt: 0,
      roundCount: 0,
    },
    l2: [],
    evidence: [],
    reflectionLogs: [],
    conflictLogs: [],
    version: 1,
    ...patch,
  }
}

describe("memory audit", () => {
  it("flags historical L2 entries with missing evidence chains", () => {
    const store = baseStore({
      l2: [{
        id: "l2_dirty",
        content: "用户喜欢跑步",
        triggerText: "我喜欢跑步",
        sourceConversationId: "conv",
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
        weight: 0,
        isPinned: false,
        status: "active",
        evidenceIds: ["ev_missing"],
      }],
      evidence: [],
    })

    const findings = auditMemoryStore(store)

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "missing_evidence",
        severity: "error",
        l2Id: "l2_dirty",
      }),
    ]))
  })

  it("flags absolute overclaims when the evidence quote did not contain the absolute term", () => {
    const store = baseStore({
      l2: [{
        id: "l2_overclaim",
        content: "用户以后都只吃香菇和平菇",
        triggerText: "我这次想吃香菇和平菇",
        sourceConversationId: "conv",
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
        weight: 0,
        isPinned: false,
        status: "active",
        evidenceIds: ["ev_1"],
      }],
      evidence: [{
        id: "ev_1",
        memoryId: "l2_overclaim",
        quoteSnippet: "我这次想吃香菇和平菇",
        createdAt: 1,
        sourceStatus: "active",
      }],
    })

    const findings = auditMemoryStore(store)

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "absolute_overclaim",
        severity: "warning",
        l2Id: "l2_overclaim",
      }),
    ]))
  })

  it("flags active memories that still carry conflict markers", () => {
    const store = baseStore({
      l2: [{
        id: "l2_conflicted",
        content: "用户喜欢咖啡",
        triggerText: "我喜欢咖啡",
        sourceConversationId: "conv",
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
        weight: 0,
        isPinned: false,
        status: "active",
        conflictWith: ["rag_other"],
      }],
    })

    const findings = auditMemoryStore(store)

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "active_conflict_marker",
        severity: "warning",
        l2Id: "l2_conflicted",
      }),
    ]))
  })

  it("reads a memory.json file and summarizes findings by code and severity", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-audit-"))
    const filePath = path.join(dir, "memory.json")
    fs.writeFileSync(filePath, JSON.stringify(baseStore({
      l2: [{
        id: "l2_dirty",
        content: "用户喜欢跑步",
        triggerText: "我喜欢跑步",
        sourceConversationId: "conv",
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 0,
        weight: 0,
        isPinned: false,
        status: "active",
        evidenceIds: ["ev_missing"],
      }],
    }), null, 2), "utf8")

    const report = auditMemoryFile(filePath)
    const summary = summarizeMemoryAudit(report.findings)

    expect(report.filePath).toBe(filePath)
    expect(summary.total).toBe(1)
    expect(summary.byCode.missing_evidence).toBe(1)
    expect(summary.bySeverity.error).toBe(1)
  })
})
