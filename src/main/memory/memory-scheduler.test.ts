import { describe, expect, it, vi } from "vitest"
import { MemoryScheduler } from "./memory-scheduler"
import type { MemorySchedulerDeps } from "./memory-scheduler"
import type { MemoryJudgeResult } from "./memory-schemas"
import type { MemoryCandidate, MemoryJudgeTurn } from "./memory-types"

function createScheduler(overrides: Partial<MemorySchedulerDeps> = {}) {
  const calls: string[] = []
  const enqueueLabels: string[] = []
  let roundCount = 0
  let queue = Promise.resolve()
  const deps: MemorySchedulerDeps = {
    ingestEntities: vi.fn((entities: unknown[]) => {
      calls.push(`ingest:${entities.length}`)
    }),
    enqueueTask: <T>(label: string, task: () => Promise<T>) => {
      enqueueLabels.push(label)
      calls.push("enqueue")
      const run = queue.then(task)
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    judgeMemory: vi.fn(async () => ({ candidates: [], entities: [] }) as MemoryJudgeResult),
    writeMemory: vi.fn(async () => {
      calls.push("write")
    }),
    getL1: vi.fn(async () => ({
      recentGoals: "",
      recentPreferences: "",
      currentProject: "",
      generatedAt: 0,
        roundCount,
      })),
    replaceL1Field: vi.fn(async (_field: "roundCount", value: number) => {
      roundCount = value
      calls.push(`round:${value}`)
    }),
    runReflectionAndCompression: vi.fn(async () => {
      calls.push("reflection")
    }),
    runResolverQueueOnce: vi.fn(async () => {
      calls.push("resolver")
    }),
    runDecay: vi.fn(async () => {
      calls.push("decay")
    }),
    ...overrides,
  }

  return { scheduler: new MemoryScheduler(deps), deps, calls, enqueueLabels }
}

describe("MemoryScheduler", () => {
  it("defers MemoryJudge until every sixth round", async () => {
    const { scheduler, deps, enqueueLabels } = createScheduler()

    for (let i = 1; i <= 5; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 5))

    // 实体抽取改由 judge 顺手产出，非 judge 轮（5 < 6）不 ingest 实体
    expect(deps.ingestEntities).not.toHaveBeenCalled()
    expect(enqueueLabels).toEqual(["MemoryMaintenance", "MemoryMaintenance", "MemoryMaintenance", "MemoryMaintenance", "MemoryMaintenance"])
    expect(deps.judgeMemory).not.toHaveBeenCalled()
    expect(deps.writeMemory).not.toHaveBeenCalled()
  })

  it("runs MemoryJudge on the sixth round with turns 1 through 6", async () => {
    const candidate: MemoryCandidate = {
      layer: "L2",
      summary: "用户喜欢香菇",
      content: "用户喜欢香菇",
      confidence: 0.9,
      triggerText: "我喜欢香菇",
      slug: "喜欢香菇",
      sourceQuote: "我喜欢香菇，尤其爱吃鲜香菇",
      importance: "medium",
      stability: "situational",
      certainty: "explicit",
      attribution: "user_explicit",
      evidenceQuotes: ["我喜欢香菇"],
      contextSummary: "用户表达食物偏好",
      shouldWrite: true,
      reason: "用户明确表达",
      forbiddenOverclaims: [],
    }
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => ({ candidates: [candidate], entities: [] }) as MemoryJudgeResult),
    })

    for (let i = 1; i <= 6; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.writeMemory).toHaveBeenCalledWith([candidate]))

    const turns = vi.mocked(deps.judgeMemory).mock.calls[0][0]
    expect(turns.map((turn: MemoryJudgeTurn) => turn.userInput)).toEqual([
      "user 1",
      "user 2",
      "user 3",
      "user 4",
      "user 5",
      "user 6",
    ])
    expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 6)
  })

  it("uses an overlapping 8-turn window on later MemoryJudge runs", async () => {
    const { scheduler, deps } = createScheduler()

    for (let i = 1; i <= 12; i++) {
      scheduler.scheduleMemoryWrite(`user ${i}`, `assistant ${i}`)
    }
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 12))

    expect(deps.judgeMemory).toHaveBeenCalledTimes(2)
    const secondTurns = vi.mocked(deps.judgeMemory).mock.calls[1][0]
    expect(secondTurns.map((turn: MemoryJudgeTurn) => turn.userInput)).toEqual([
      "user 5",
      "user 6",
      "user 7",
      "user 8",
      "user 9",
      "user 10",
      "user 11",
      "user 12",
    ])
  })

  it("still increments round count when judging fails", async () => {
    const { scheduler, deps } = createScheduler({
      judgeMemory: vi.fn(async () => {
        throw new Error("judge failed")
      }),
    })

    scheduler.scheduleMemoryWrite("user", "assistant")
    await vi.waitFor(() => expect(deps.replaceL1Field).toHaveBeenCalledWith("roundCount", 1))

    expect(deps.judgeMemory).not.toHaveBeenCalled()
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
