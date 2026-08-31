import { DmaeEntry, DmaeManager, DmaeParams, DefaultRewardStrategy, deriveState, QuadraticResistanceDecay } from "../rag/worldbook"
import { L2Memory, L2DmaeState } from "./memory-types"
import { memoryStore } from "./memory-store"

// V5 L2 专用 DMAE 参数（与用户确认值一致）
export const L2_DMAE_PARAMS: DmaeParams = {
  maxScore: 100,
  promptThreshold: 30,
  userRewardBase: 10,
  wakeGamma: 0.5,
  modelRewardBase: 4,
  wakeLambda: 0.3,
  decayAlpha: 1.0,
  decayBeta: 0.2,
  repeatRho: 0.5,
  satPower: 2,
  repeatWindow: 6,
  wakeBonus: 5,
}

// L2 位次 I 梯度：向量召回 top-4 分别赋予 I=[36,8,8,1]
// 位次 1 期望活跃 4 轮，位次 2/3 期望 3 轮，位次 4 期望 2 轮
export const L2_INTRINSIC_BY_RANK = [36, 8, 8, 1]

interface L2DmaeEntry extends DmaeEntry {
  l2: L2Memory
}

function adaptL2(l2: L2Memory, state: L2DmaeState): L2DmaeEntry {
  return {
    id: l2.id,
    keywords: l2.keywords ?? [],
    intrinsicValue: state.intrinsicValue,
    permanent: l2.isPinned,
    enabled: l2.status !== "archived",
    l2,
  }
}

function defaultL2DmaeState(l2Id: string): L2DmaeState {
  return {
    l2Id,
    activation: 0,
    intrinsicValue: 0,
    userSilence: 0,
    modelSilence: 0,
    recentUserHits: [],
    state: "archived",
  }
}

/**
 * L2 Working Memory 的 DMAE 管理器。
 * - 使用 V5 L2 专用参数与位次 I 梯度
 * - 向量召回 top-K 视为 userHit（H_u=1）
 * - 非召回但 keywords 命中也视为 userHit/modelHit
 * - 热层（active/dormant）参与更新，archived 未命中则跳过
 * - 状态持久化到 memory.json 的 l2DmaeStates
 */
export class L2DmaeManager {
  private dmae = new DmaeManager<L2DmaeEntry>({
    params: L2_DMAE_PARAMS,
    rewardStrategy: new DefaultRewardStrategy<L2DmaeEntry>(),
    decayStrategy: new QuadraticResistanceDecay<L2DmaeEntry>(),
    debug: false,
  })

  // 运行时缓存每个 L2 的 intrinsicValue（由召回器按位次设置，不存 DmaeManager EntryState）
  private intrinsicValues = new Map<string, number>()

  // 每轮调用自动递增（调用方也可显式传入）
  private turnCounter = 0

  private loaded = false

  /** 从 memory.json 加载所有 L2 DMAE 状态到引擎 */
  async loadStates(): Promise<void> {
    const states = await memoryStore.getAllL2DmaeStates()
    this.dmae.clear()
    this.intrinsicValues.clear()
    for (const s of states) {
      this.dmae.setState(s.l2Id, {
        activation: s.activation,
        userSilence: s.userSilence,
        modelSilence: s.modelSilence,
        recentUserHits: s.recentUserHits,
      })
      this.intrinsicValues.set(s.l2Id, s.intrinsicValue)
    }
    this.loaded = true
  }

  /**
   * 为被向量召回的 L2 按召回位次设置 intrinsicValue。
   * 这是 V5 的「召回器作为上游模块提供 I」的实现。
   */
  setRecalledIntrinsicValues(recalledIds: string[]): void {
    const params = this.dmae.getParams()
    for (let i = 0; i < recalledIds.length; i++) {
      const id = recalledIds[i]
      const st = this.dmae.getState(id) ?? { activation: 0, userSilence: 0, modelSilence: 0, recentUserHits: [] }
      const I = L2_INTRINSIC_BY_RANK[Math.min(i, L2_INTRINSIC_BY_RANK.length - 1)]
      this.intrinsicValues.set(id, I)
      // 命中 Archived 时先 Wake-Up 到 promptThreshold + wakeBonus；否则保持原 activation
      let activation = st.activation
      if (deriveState(activation, params.promptThreshold) === "Archived") {
        activation = Math.min(params.maxScore, params.promptThreshold + params.wakeBonus)
      }
      this.dmae.setState(id, { ...st, activation })
    }
  }

  /**
   * 执行一轮 L2 DMAE 更新。
   * @param l2List 当前所有 L2 条目
   * @param userText 本轮用户输入
   * @param modelText 本轮模型回复
   * @param recalledIds 被向量召回的 L2 id（按 rank 排序）
   * @param turn 当前轮次编号（用于 repeatWindow）
   */
  async updateActivation(
    l2List: L2Memory[],
    userText: string,
    modelText: string,
    recalledIds: string[],
    turn?: number,
  ): Promise<void> {
    if (!this.loaded) await this.loadStates()
    const t = turn ?? ++this.turnCounter

    // 确保每条 L2 都有 DMAE 状态
    for (const l2 of l2List) {
      if (!this.dmae.getState(l2.id)) {
        const s = await memoryStore.initL2DmaeStateIfMissing(l2.id)
        this.dmae.setState(s.l2Id, {
          activation: s.activation,
          userSilence: s.userSilence,
          modelSilence: s.modelSilence,
          recentUserHits: s.recentUserHits,
        })
      }
    }

    // 按召回位次设置 I；recalledIds 本身已是按向量相似度排好序的 top-K
    this.setRecalledIntrinsicValues(recalledIds)

    // 构建 DMAE entry 适配器
    const entries = l2List.map((l2) => {
      const s = this.dmae.getState(l2.id) ?? defaultL2DmaeState(l2.id)
      const I = this.intrinsicValues.get(l2.id) ?? 0
      return adaptL2(l2, { ...s, l2Id: l2.id, intrinsicValue: I, state: deriveState(s.activation, this.dmae.getParams().promptThreshold) as any })
    })

    // 调用通用 DMAE 引擎
    this.dmae.updateActivation(entries, userText, modelText, t)

    // 同步状态回 memory.json
    await this.syncToStore()
  }

  /** 返回可注入 prompt 的 L2：isPinned 常驻优先，其余按 activation 降序取 active */
  async getActiveL2ForPrompt(l2List: L2Memory[], maxCount = 4): Promise<L2Memory[]> {
    if (!this.loaded) await this.loadStates()

    const pinned = l2List.filter((l2) => l2.isPinned)
    const nonPinned = l2List.filter((l2) => !l2.isPinned && l2.status !== "archived")

    const entries = nonPinned.map((l2) => {
      const s = this.dmae.getState(l2.id) ?? defaultL2DmaeState(l2.id)
      const I = this.intrinsicValues.get(l2.id) ?? 0
      return adaptL2(l2, { ...s, l2Id: l2.id, intrinsicValue: I, state: deriveState(s.activation, this.dmae.getParams().promptThreshold) as any })
    })

    const active = this.dmae.getActiveEntries(entries, this.dmae.getParams().promptThreshold)
    return [...pinned, ...active.map((e) => e.l2)].slice(0, maxCount)
  }

  /** 把引擎内所有状态写回 memory.json */
  private async syncToStore(): Promise<void> {
    // 这里用 init/update 组合实现全量同步：
    // memoryStore 已提供 updateL2DmaeState，但没有批量接口；由于 L2 数量少，逐条更新可接受。
    const params = this.dmae.getParams()
    // DmaeManager 的 state 是私有 Map，无法直接遍历；通过 getState 逐个 L2 id 读取。
    // 为了知道有哪些 id，需要从 memoryStore 读取当前所有 L2DmaeState。
    const current = await memoryStore.getAllL2DmaeStates()
    for (const s of current) {
      const engineState = this.dmae.getState(s.l2Id)
      if (!engineState) continue
      const state = deriveState(engineState.activation, params.promptThreshold)
      await memoryStore.updateL2DmaeState(s.l2Id, {
        activation: engineState.activation,
        intrinsicValue: this.intrinsicValues.get(s.l2Id) ?? s.intrinsicValue, // 保持召回器设置的 I
        userSilence: engineState.userSilence,
        modelSilence: engineState.modelSilence,
        recentUserHits: engineState.recentUserHits,
        state: state as L2DmaeState["state"],
      })
    }
  }
}

export const l2DmaeManager = new L2DmaeManager()
