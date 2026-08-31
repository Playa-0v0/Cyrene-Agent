import { beforeEach, describe, expect, it, vi } from "vitest"
import { L2DmaeManager, L2_DMAE_PARAMS, L2_INTRINSIC_BY_RANK } from "./l2-dmae-manager"
import type { L2DmaeState, L2Memory } from "./memory-types"

const memoryStoreMock = vi.hoisted(() => ({
  getAllL2DmaeStates: vi.fn(),
  getL2DmaeState: vi.fn(),
  initL2DmaeStateIfMissing: vi.fn(),
  updateL2DmaeState: vi.fn(),
}))

vi.mock("./memory-store", () => ({ memoryStore: memoryStoreMock }))

function makeL2(id: string, content: string, opts: Partial<L2Memory> = {}): L2Memory {
  return {
    id,
    content,
    triggerText: content,
    sourceConversationId: "conv-1",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    weight: 0,
    isPinned: false,
    status: "active",
    keywords: [...content],
    ...opts,
  } as L2Memory
}

describe("L2DmaeManager", () => {
  beforeEach(() => {
    const states = new Map<string, L2DmaeState>()
    memoryStoreMock.getAllL2DmaeStates.mockReset()
    memoryStoreMock.getAllL2DmaeStates.mockImplementation(async () => Array.from(states.values()))
    memoryStoreMock.getL2DmaeState.mockReset()
    memoryStoreMock.getL2DmaeState.mockImplementation(async (l2Id: string) => states.get(l2Id))
    memoryStoreMock.initL2DmaeStateIfMissing.mockReset()
    memoryStoreMock.initL2DmaeStateIfMissing.mockImplementation(async (l2Id: string) => {
      if (!states.has(l2Id)) {
        states.set(l2Id, {
          l2Id,
          activation: 0,
          intrinsicValue: 0,
          userSilence: 0,
          modelSilence: 0,
          recentUserHits: [],
          state: "archived",
        })
      }
      return states.get(l2Id)!
    })
    memoryStoreMock.updateL2DmaeState.mockReset()
    memoryStoreMock.updateL2DmaeState.mockImplementation(async (l2Id: string, patch: Partial<L2DmaeState>) => {
      const current = states.get(l2Id) ?? {
        l2Id,
        activation: 0,
        intrinsicValue: 0,
        userSilence: 0,
        modelSilence: 0,
        recentUserHits: [],
        state: "archived",
      }
      const merged = { ...current, ...patch, l2Id }
      states.set(l2Id, merged)
      return merged
    })
  })

  it("uses V5 L2 params and I gradient", () => {
    expect(L2_DMAE_PARAMS.userRewardBase).toBe(10)
    expect(L2_DMAE_PARAMS.modelRewardBase).toBe(4)
    expect(L2_DMAE_PARAMS.decayAlpha).toBe(1.0)
    expect(L2_DMAE_PARAMS.decayBeta).toBe(0.2)
    expect(L2_INTRINSIC_BY_RANK).toEqual([36, 8, 8, 1])
  })

  it("recalled top-4 entries get I gradient and become active", async () => {
    const mgr = new L2DmaeManager()
    const l2 = makeL2("l2_a", "咖啡因敏感")
    await mgr.updateActivation([l2], "我喝咖啡会失眠", "", ["l2_a"], 0)

    const active = await mgr.getActiveL2ForPrompt([l2])
    expect(active.map((m) => m.id)).toContain("l2_a")

    const saved = memoryStoreMock.updateL2DmaeState.mock.calls.find((c) => c[0] === "l2_a")?.[1]
    expect(saved?.intrinsicValue).toBe(36)
  })

  it("non-recalled keyword hit still activates L2", async () => {
    const mgr = new L2DmaeManager()
    const l2 = makeL2("l2_b", "喜欢雨天散步")
    // 首次出现：无 recall，但用户输入含关键词「雨天」和「散步」
    await mgr.updateActivation([l2], "今天雨天，我去散步", "", [], 0)

    const active = await mgr.getActiveL2ForPrompt([l2])
    expect(active.map((m) => m.id)).toContain("l2_b")
  })

  it("repeated hits within repeatWindow are suppressed", async () => {
    const mgr = new L2DmaeManager()
    const l2 = makeL2("l2_c", "周末去爬山")

    // 第 1 轮：recall
    await mgr.updateActivation([l2], "周末去爬山", "", ["l2_c"], 1)
    const state1 = memoryStoreMock.updateL2DmaeState.mock.calls.find((c) => c[0] === "l2_c")?.[1]
    const a1 = state1?.activation as number

    // 第 2 轮：仍在 repeatWindow 内再次 recall
    await mgr.updateActivation([l2], "周末去爬山", "", ["l2_c"], 2)
    const state2 = memoryStoreMock.updateL2DmaeState.mock.calls.find((c) => c[0] === "l2_c")?.[1]
    const a2 = state2?.activation as number

    // 重复命中奖励应被抑制，activation 不会第二次大幅上涨
    expect(a2).toBeLessThanOrEqual(a1 + L2_DMAE_PARAMS.userRewardBase * 0.5)
  })

  it("archived entries skip update when not hit", async () => {
    const mgr = new L2DmaeManager()
    memoryStoreMock.getAllL2DmaeStates.mockResolvedValue([{
      l2Id: "l2_d",
      activation: 0,
      intrinsicValue: 1,
      userSilence: 100,
      modelSilence: 100,
      recentUserHits: [],
      state: "archived",
    }] as L2DmaeState[])

    const l2 = makeL2("l2_d", "旧记忆", { status: "archived" })
    await mgr.loadStates()
    await mgr.updateActivation([l2], "完全不相关的话题", "", [], 0)

    const saved = memoryStoreMock.updateL2DmaeState.mock.calls.find((c) => c[0] === "l2_d")?.[1]
    expect(saved?.userSilence).toBe(100)
    expect(saved?.modelSilence).toBe(100)
  })

  it("returns active entries sorted by activation descending", async () => {
    const mgr = new L2DmaeManager()
    const a = makeL2("l2_high", "高优先级记忆")
    const b = makeL2("l2_low", "低优先级记忆")

    // a 被 recall 到 rank 1，b 到 rank 4
    await mgr.updateActivation([a, b], "用户输入", "", ["l2_high", "l2_low"], 0)

    const active = await mgr.getActiveL2ForPrompt([a, b])
    expect(active[0].id).toBe("l2_high")
    expect(active[1].id).toBe("l2_low")
  })
})
