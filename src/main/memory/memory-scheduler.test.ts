import { describe, expect, it, vi } from "vitest"
import { MemoryScheduler } from "./memory-scheduler"
import type { MemorySchedulerDeps } from "./memory-scheduler"
import type { MemoryCandidate } from "./memory-types"

function createScheduler(overrides: Partial<MemorySchedulerDeps> = {}) {
  const calls: string[] = []
  const enqueueLabels: string[] = []
  const deps: MemorySchedulerDeps = {
    ingestEntity: vi.fn((text: string) => {
      calls.push(`ingest:${text}`)
    }),
    enqueueTask: async <T>(label: string, task: () => Promise<T>) => {
      enqueueLabels.push(label)
      calls.push("enqueue")
      return task()
    },
    judgeMemory: vi.fn(async () => [] as MemoryCandidate[]),
    writeMemory: vi.fn(async () => {
      calls.push("write")
    }),
    getL1: vi.fn(async () => ({
      recentGoals: "",
      recentPreferences: "",
      currentProject: "",
      generatedAt: 0,
      roundCount: 0,
    })),
    replaceL1Field: vi.fn(async (_field: "roundCount", value: number) => {
      calls.push(`round:${value}`)
    }),
    runReflectionAndCompression: vi.fn(async () => {
      calls.push("reflection")
    }),
    runResolverQueueOnce: vi.fn(async () => {
      calls.push("resolver")
    }),
    ...overrides,
  }

  return { scheduler: new MemoryScheduler(deps), deps, calls, enqueueLabels }
}

describe("MemoryScheduler", () => {
  it("ingests entities, enqueues memory judging, writes candidates, and increments round count", async () => {
    const candidate: MemoryCandidate = {
      layer: "L2",
      content: "用户喜欢香菇",
      confidence: 0.9,
      triggerText: "我喜欢香菇",
    }
    const { scheduler, deps, enqueueLabels } = createScheduler({
      judgeMemory: vi.fn(async () => [candidate]),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 1))

    expect(deps.ingestEntity).toHaveBeenCalledTimes(2)
    expect(enqueueLabels).toEqual(["MemoryJudge"])
    expect(deps.writeMemory).toHaveBeenCalledWith([candidate])
  })

  it("still increments round count when judging fails", async () => {
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => {
        throw new Error("judge failed")
      }),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 1))

    expect(deps.writeMemory).not.toHaveBeenCalled()
  })

  it("runs reflection and compression on every twentieth round", async () => {
    const { scheduler, deps } = createScheduler({
      getL1: vi.fn(async () => ({
        recentGoals: "",
        recentPreferences: "",
        currentProject: "",
        generatedAt: 0,
        roundCount: 19,
      })),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.runReflectionAndCompression).toHaveBeenCalled())

    expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 20)
  })

  it("runs one resolver queue item every fifth round", async () => {
    const { scheduler, deps } = createScheduler({
      getL1: vi.fn(async () => ({
        recentGoals: "",
        recentPreferences: "",
        currentProject: "",
        generatedAt: 0,
        roundCount: 4,
      })),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.runResolverQueueOnce).toHaveBeenCalled())

    expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 5)
  })
})
