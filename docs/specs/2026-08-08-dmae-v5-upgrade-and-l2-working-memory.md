# DMAE V4→V5.1 升级 + L2 Working Memory 接入设计

**日期**：2026-08-08  
**状态**：设计已确认，待实现  
**LogTag**：Cyrene

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [决策清单](#2-决策清单)
3. [现状分析](#3-现状分析)
4. [V4→V5.1 升级范围](#4-v4v51-升级范围)
5. [L2 Working Memory 接入设计](#5-l2-working-memory-接入设计)
6. [位次衰减数值设计](#6-位次衰减数值设计)
7. [Decay 触发机制设计](#7-decay-触发机制设计)
8. [工程实现清单](#8-工程实现清单)
9. [验证计划](#9-验证计划)

---

## 1. 背景与目标

### 1.1 问题

当前 L2 记忆召回是无状态每轮独立检索：
- `buildMemoryInjection(userText)` 每轮重新向量检索 top-5（[orchestrator/index.ts:33](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/orchestrator/index.ts#L33)）
- 上一轮召回的记忆不会自动保留到下一轮
- 话题一转，旧记忆立即从 prompt 消失
- **没有跨轮驻留能力（working memory buffer 不存在）**

### 1.2 目标

1. **DMAE V4→V5.1 升级**：落地白皮书 L20 标注的"尚未落地"特性（饱和抑制 / 重复抑制 / Wake-Up 重构 / Archived skip update）
2. **L2 接入 DMAE**：给 L2 记忆加跨轮驻留——被召回后按位次获得不同衰减速率的生命周期，实现 working memory buffer
3. **TopK 调整**：5 → 4
4. **位次衰减**：TopK 位次越靠后，衰减越快（驻留轮数越短）

---

## 2. 决策清单

| # | 决策 | 确认 |
|---|---|---|
| 1 | TopK = 4 | ✓ |
| 2 | 复用 V4 代码抽象（不复制） | ✓ |
| 3 | 先升级 V5.1，再接 L2 | ✓ |
| 4 | 位次衰减通过 I 值梯度实现（不改公式） | ✓ |
| 5 | 位次衰减轮数：位次1=4轮 / 位次2=3轮 / 位次3=3轮 / 位次4=2轮 跌破 Dormant | ✓ |
| 6 | Decay 触发机制：L2 专用（不依赖 S_u/S_m 关键词命中） | 待定（见 §7） |

---

## 3. 现状分析

### 3.1 DMAE V4 工程实现（[worldbook.ts](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts)）

**已实现**：
- `EntryState`：activation / userSilence / modelSilence（[L21-26](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L21-L26)）
- `DmaeParams`：8 个参数（maxScore/promptThreshold/userRewardBase/wakeGamma/modelRewardBase/wakeLambda/decayAlpha/decayBeta）（[L36-51](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L36-L51)）
- `DefaultRewardStrategy`：Ru = Bu×(1+γ·ln(1+U_old))，Rm = Bm×e^(-λ·U_old)（[L101-110](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L101-L110)）
- `QuadraticResistanceDecay`：D = (α·U²+β·M²)/√I（[L116-125](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L116-L125)）
- `updateActivation`：两阶段（snapshot old → update silence → reward → decay → commit）（[L349-473](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L349-L473)）
- Wake-Up（Archived 复活 Floor）：`aNew = max(aNew, entry.intrinsicValue)`（[L414-416](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L414-L416)）
- One-Shot cascade（1 层封顶，不入状态表）（[L446-478](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L446-L478)）

**V5.1 待落地（白皮书 L20）**：
- ✗ 饱和抑制 `G_sat(A) = (1 - A/A_max)^p`（V5 §5.4）
- ✗ 重复抑制 `G_repeat(n_w) = 1/(1+ρ·n_w)`（V5 §5.5）
- ✗ Wake-Up 重构：`A_init = min(A_max, T_active + B_w)`（V5 §7.4）—— V4 用 `intrinsicValue` 作 Floor，V5 改用 `T_active + B_w`
- ✗ Archived skip update（V5 §11.2 步骤 5）—— V4 每轮扫所有条目，V5 应跳过未命中的 Archived
- ✗ `recentUserHits[]` 窗口（V5 §5.5 需要）
- ✗ `DmaeParams` 扩展：`repeatRho` / `satPower` / `repeatWindow` / `wakeBonus`

### 3.2 L2 召回链路现状

```
用户输入
  → buildMemoryInjection(userInput)                    [orchestrator/index.ts:26]
    → searchMemoryEntries(userInput, "user_memory", 5)  [orchestrator/index.ts:33]
      → HybridRetriever.retrieve(query, source, topK=5)[rag/retriever.ts:205]
        → vector search (topK*3=15 候选) + BM25 (topK*3=15 候选)
        → hybrid fusion: vec*0.7 + bm25*0.3            [retriever.ts:251]
        → optional reranker                            [retriever.ts:259-273]
      → top-5 返回
    → recordRecentMemorySearchEntries()                 [orchestrator/index.ts:35]
    → 注入 prompt："【相关记忆】\n· {content}（原文：{sourceQuote}）"
  → 下一轮重复上述流程（无状态）
```

**关键缺口**：
- 向量层有 recency 衰减（`decayFactor = 0.95^(h/24)`，[vectorstore.ts:480-503](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/vectorstore.ts#L480-L503)），但只降召回分，不提供驻留
- BM25 分支无时间衰减（[retriever.ts:350](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/retriever.ts#L350)）
- L2 无 working memory buffer——每轮独立检索，无跨轮驻留

### 3.3 L2 与 Worldbook 的数据模型差异

| 维度 | WorldbookEntry | L2Memory |
|---|---|---|
| 来源 | .md 文件静态加载 | 运行时 LLM 抽取 + 持久化 |
| keywords | 显式字段（触发词） | 无（用 content 分词 / evidence 实体） |
| intrinsicValue | .md frontmatter 显式 | 无（需运行时赋值） |
| permanent | .md frontmatter | L2 有 isPinned（语义等价） |
| 命中方式 | 关键词子串匹配 `text.includes(kw)` | **向量召回**（不是关键词命中） |
| 持久化 | 重启从 .md 重载（state 回 0） | 持久化到 store（activation 需独立持久化） |

**核心冲突**：L2 被召回 ≠ 关键词命中。V5 Decay 公式 `D = (α·S_u²+β·S_m²)/√I` 依赖 S_u/S_m（用户/模型发言中的关键词命中），L2 没有这个信号 → 需要重新定义 Decay 触发机制（见 §7）。

---

## 4. V4→V5.1 升级范围

按白皮书附录对照，V4→V5.1 需要落地的改动（按依赖顺序）：

### 4.1 DmaeParams 扩展（[worldbook.ts:36-51](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L36-L51)）

新增 4 个参数（对齐 V5 附录 B 默认值）：

```ts
export interface DmaeParams {
  // ... 现有 8 个字段保持不变
  repeatRho: number;      // ρ = 0.5   重复抑制强度
  satPower: number;       // p = 2     饱和抑制幂次
  repeatWindow: number;   // w = 6     重复统计窗口轮数
  wakeBonus: number;      // B_w = 5   唤醒补偿
}
```

`DEFAULT_DMAE_PARAMS` 补齐默认值。

### 4.2 EntryState 扩展（[worldbook.ts:21-26](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L21-L26)）

新增 `recentUserHits: number[]`（V5 §5.5 窗口命中记录）：

```ts
export interface EntryState {
  activation: number;
  userSilence: number;
  modelSilence: number;
  recentUserHits: number[];  // V5 §5.5：最近 w 轮的用户命中时间戳
}
```

`loadFromDirectory` / `loadFromEntries` 初始化时 `recentUserHits: []`。

### 4.3 饱和抑制 G_sat（V5 §5.4）

新增策略函数（或并入 `DefaultRewardStrategy`）：

```ts
function gateSaturation(activation: number, p: number, aMax: number): number {
  if (activation >= aMax) return 0;
  return Math.pow(1 - activation / aMax, p);
}
```

### 4.4 重复抑制 G_repeat（V5 §5.5）

```ts
function gateRepeat(hitCount: number, rho: number): number {
  return 1 / (1 + rho * hitCount);
}
```

### 4.5 有效用户奖励 R_u*（V5 §5.6）

`DefaultRewardStrategy.userReward` 改为：

```ts
userReward(ctx: RewardContext): number {
  const { snap, params } = ctx;
  const base = params.userRewardBase * (1 + params.wakeGamma * Math.log(1 + snap.userSilence));
  const gSat = gateSaturation(snap.activation, params.satPower, params.maxScore);
  const gRep = gateRepeat(ctx.recentHitCount ?? 0, params.repeatRho);
  return base * gSat * gRep;
}
```

`RewardContext` 需新增 `recentHitCount?: number` 字段。

### 4.6 Wake-Up 重构（V5 §7.4）

**V4 行为**（[worldbook.ts:414-416](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L414-L416)）：
```ts
if (userHit && deriveState(aOld, th) === ARCHIVED) {
  aNew = Math.max(aNew, entry.intrinsicValue);  // Floor = I
}
```

**V5 行为**：Wake-Up 改为**初值改写**（在 update 前执行），Floor = `T_active + B_w`：

```ts
// Lifecycle Phase（update 前）：
if (userHit && deriveState(aOld, th) === ARCHIVED) {
  aInit = Math.min(maxScore, th + params.wakeBonus);  // A_init = T_active + B_w
} else {
  aInit = aOld;
}
// Update Phase：
aNew = clamp(aInit + R_u* + R_m - D);
```

**关键**：R_m 的 Active gating 读 `aOld`（改写前），不是 `aInit`（V5 §7.4.4 保证）。

### 4.7 Archived skip update（V5 §11.2 步骤 5）

未命中的 Archived 条目跳过本轮计算：

```ts
// updateActivation 主循环：
if (deriveState(aOld, th) === ARCHIVED && !userHit && !modelHit) {
  continue;  // SkipUpdate
}
```

### 4.8 不变量 clamp 调整

V4 的 `Rm = min(Rm, D - ε)` clamp 逻辑保留（[worldbook.ts:407](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts#L407)），但 V5 的 `G_sat` 已经天然限制了饱和，clamp 仍作为数值安全网。

### 4.9 不升级的部分

- **双层 Activation**（V5 §8.4 `A = A_base + A_burst`）—— V5 标注"不作为 5.0 默认实现"
- **参数自适应**（V5 附录 D.4）—— 刻意不做，外层包装
- **多级 cascade**（V5 附录 D.5）—— 保持 1 层封顶
- **冷存储召回索引**（V5 §7.2）—— 当前 worldbook 全量在内存，L2 走 vectorstore，暂不需要

---

## 5. L2 Working Memory 接入设计

### 5.1 核心思路：复用 DMAE 引擎，抽象 entry 接口

DMAE V4 已是抽象于"条目"的引擎，`WorldbookEntry` 只是其中一种实现。接入 L2 只需：

1. **抽象 `DmaeEntry` 接口**
2. **`WorldbookManager` 泛型化为 `DmaeManager<T extends DmaeEntry>`**
3. **L2Memory 实现 `DmaeEntry`**
4. **新建 `L2DmaeManager`（或复用 `DmaeManager`）管理 L2 生命周期**

### 5.2 DmaeEntry 接口设计

```ts
// 新增：src/main/rag/dmae-types.ts（或并入 worldbook.ts）
export interface DmaeEntry {
  id: string;
  keywords: string[];        // 命中检测用；L2 用 content 分词 / evidence 实体
  intrinsicValue: number;    // 抗遗忘能力；L2 召回时按位次临时赋值
  resident: boolean;         // 常驻：旁路 DMAE；L2 的 isPinned 映射到此
  enabled: boolean;
}
```

`WorldbookEntry` 和 `L2Memory` 都实现此接口：

| DmaeEntry 字段 | WorldbookEntry 来源 | L2Memory 来源 |
|---|---|---|
| id | entry.id | l2.id |
| keywords | entry.keywords（.md 触发词） | 分词 content / evidence entities（需提取） |
| intrinsicValue | entry.intrinsicValue（.md 内在价值） | **运行时按 TopK 位次赋值**（见 §6） |
| resident | entry.permanent | l2.isPinned |
| enabled | entry.enabled | !l2.archived（L2 status != archived） |

### 5.3 L2 DMAE 状态独立持久化

L2 的 DMAE state 不能像 worldbook 那样重启回 0（L2 是持久化记忆）。需要：

```ts
// 新增 L2 DMAE state 持久化（扩展 memory-store 或独立文件）
interface L2DmaeState {
  l2Id: string;
  activation: number;
  userSilence: number;
  modelSilence: number;
  recentUserHits: number[];
  injectedAtTurn?: number;  // 被召回注入的轮次（用于 working memory TTL）
}
```

存储位置：`memory-store` 内新增 `l2DmaeStates: Map<string, L2DmaeState>`，或独立 `l2-dmae-state.json`。

### 5.4 L2 Working Memory 工作流

```
每轮对话开始
  │
  ├─ 1. 向量检索 top-4 L2（buildMemoryInjection）
  │     → 按位次赋 I 值：位次1=90 / 位次2=60 / 位次3=30 / 位次4=10
  │     → 被召回的 L2 注入 prompt
  │     → DMAE: activation 拉高（Wake-Up if Archived / Reward if Active/Dormant）
  │
  ├─ 2. 未被召回但仍在 DMAE 热层的 L2
  │     → 按 Decay 公式衰减（位次决定 I → 决定衰减速率）
  │     → 若 activation 仍 ≥ T_active，继续注入 prompt（working memory 驻留）
  │     → 若 activation 跌破 T_active，退出 prompt（evict）
  │
  └─ 3. 下一轮重复
```

**关键**：步骤 2 是新增的——当前 L2 每轮只注入"被向量召回的 top-N"。接入 DMAE 后，**DMAE 热层中 activation ≥ T_active 的 L2 也会注入**，即使本轮没被向量召回。这就是 working memory buffer。

### 5.5 注入格式调整

当前（[orchestrator/index.ts:38-49](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/orchestrator/index.ts#L38-L49)）：
```
【相关记忆】
· {content}（原文：{sourceQuote}）
```

接入 DMAE 后：
```
【相关记忆】
· {content}（原文：{sourceQuote}）           ← 本轮向量召回（top-4）
· {content}                                   ← DMAE 驻留（上轮召回，仍未衰减出热层）
```

可选用标注区分来源，或合并排序后统一注入。

### 5.6 与现有 L2 status 状态机的关系

L2 已有 `status: "active" | "aging" | "archived"`（[memory-store.ts:686](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/memory/memory-store.ts#L686) `decayL2Weights`）。

**建议：DMAE state 与 L2 status 正交，不合并**：
- L2 status：业务层状态（基于固定 delta 衰减，每 50 轮触发），控制 `isL2LocallyRecallable`（是否进 RAG 候选池）
- DMAE state：生命周期层状态（基于公式衰减，每轮触发），控制 working memory 驻留

L2 status=archived 的不进 RAG 候选池，DMAE 也不会碰到它们。L2 status=active/aging 的进 RAG，同时受 DMAE 管理 working memory。

---

## 6. 位次衰减数值设计

### 6.1 用户确认的数值

| TopK 位次 | 跌破 Dormant 所需轮数 | I 值（建议） |
|---|---|---|
| 1 | 4 轮 | 90 |
| 2 | 3 轮 | 60 |
| 3 | 3 轮 | 30 |
| 4 | 2 轮 | 10 |

> **注**：位次 2 和位次 3 均为 3 轮——用户确认有意（中间两档合并）。I 值梯度为 `90/60/30/10`。

### 6.2 I 值如何实现位次衰减

V5 Decay 公式：`D = (α·S_u² + β·S_m²) / √I`

I 越大 → `1/√I` 越小 → Decay 越慢 → 驻留越久。

| 位次 | I | 1/√I（相对衰减速率） | 效果 |
|---|---|---|---|
| 1 | 90 | 0.105 | 最慢，4 轮跌破 |
| 2 | 60 | 0.129 | 中，3 轮跌破 |
| 3 | 30 | 0.183 | 中，3 轮跌破 |
| 4 | 10 | 0.316 | 最快，2 轮跌破 |

### 6.3 L2 召回时赋 I 值

```ts
// buildMemoryInjection 中，向量检索返回 top-4 后：
const I_BY_RANK = [90, 60, 30, 10];  // 位次 1/2/3/4
userMemoryEntries.forEach((entry, index) => {
  const rank = index;  // 0-based
  const iValue = I_BY_RANK[rank] ?? 10;
  l2DmaeManager.setIntrinsicValue(entry.id, iValue);
  l2DmaeManager.markRecalled(entry.id);  // 触发 Wake-Up / Reward
});
```

**关键**：I 值是临时的，每次召回重新赋值（L2 的"相关性"是相对当前查询的，不是固定的）。

### 6.4 精确参数校准

"4 轮跌破"需要反推 `decayAlpha`（V4 默认 1.5，针对 worldbook 的 8 轮目标）。

假设位次 1（I=90）要在 4 轮内从 `T_active + B_w = 35` 跌破 `T_active = 30`：

```
4 轮后 D 累积 ≥ 5（35-30）
D_per_turn = α × S² / √I  （假设 S_m = 0，纯用户沉默）
  轮1: S=1, D = α×1/√90 = α×0.105
  轮2: S=2, D = α×4/√90 = α×0.422
  轮3: S=3, D = α×9/√90 = α×0.949
  轮4: S=4, D = α×16/√90 = α×1.687
累计 D = α × (0.105+0.422+0.949+1.687) = α × 3.163
需要 α × 3.163 ≥ 5 → α ≥ 1.58
```

位次 4（I=10）2 轮跌破：
```
  轮1: S=1, D = α×1/√10 = α×0.316
  轮2: S=2, D = α×4/√10 = α×1.265
累计 D = α × 1.581
需要 α × 1.581 ≥ 5 → α ≥ 3.16
```

**结论**：单一 `decayAlpha` 无法同时满足"位次1=4轮"和"位次4=2轮"。需要 L2 专用 `decayAlpha`，或让 I 值梯度更陡。

**建议方案**：L2 用独立的 `DmaeParams` 实例，`decayAlpha` 设为 ~3.2（满足位次4=2轮），然后调 I 值让位次1=4轮：

| 位次 | 目标轮数 | 所需 I（α=3.2） | 建议调整后 I |
|---|---|---|---|
| 1 | 4 | α×3.163/√I ≥ 5 → √I ≤ 2.024 → I ≤ 4.1 | I=4 → 4 轮 |
| 2 | 3 | α×(0.316+1.265+2.846)/√I ≥ 5 → √I ≤ 2.826 → I ≤ 8.0 | I=8 → 3 轮 |
| 3 | 3 | 同上 | I=8 → 3 轮 |
| 4 | 2 | α×1.581/√I ≥ 5 → √I ≤ 1.012 → I ≤ 1.0 | I=1 → 2 轮 |

**最终建议数值**（需 Simulator 验证）：

| 位次 | I 值 | α | 预期跌破轮数 |
|---|---|---|---|
| 1 | 4 | 3.2 | ~4 轮 |
| 2 | 8 | 3.2 | ~3 轮 |
| 3 | 8 | 3.2 | ~3 轮 |
| 4 | 1 | 3.2 | ~2 轮 |

> ⚠️ 以上为理论反推，实际需 Simulator 跑场景验证（含 Reward/Wake-Up 交互）。实现后用 `src/main/sim/` 跑 `four-tier-mix` 场景校准。

---

## 7. Decay 触发机制设计（待定，需用户拍板）

### 7.1 问题

V5 Decay `D = (α·S_u² + β·S_m²) / √I` 依赖：
- `S_u`：用户发言中关键词命中沉默轮数
- `S_m`：模型发言中关键词命中沉默轮数

Worldbook：用户说"剑" → 命中关键词 → S_u=0；不说 → S_u++。

**L2 没有关键词命中**——L2 被向量召回，不是字面匹配。如果直接套 V5 公式：
- L2 被召回那轮 S_u/S_m = 0 → D = 0 → 不衰减
- L2 未被召回那轮 S_u/S_m 持续 ++ → D 累积 → 衰减

**这其实可以工作**，但需要定义"召回"是否等价于"命中"。

### 7.2 方案 A：向量召回 = 用户命中（推荐）

**定义**：L2 被向量检索召回（进 top-4）= `H_u = 1`（用户命中）。

理由：向量召回基于用户输入的语义相似度，本质是"用户这轮说的话相关"。

```
本轮 L2 被召回 → H_u = 1
  → S_u = 0（重置）
  → R_u* 计算（久别重逢奖励）
  → activation 拉高
本轮 L2 未被召回 → H_u = 0
  → S_u++（沉默累积）
  → D 累积 → 衰减
```

模型命中 `H_m`：L2 content 出现在模型回复中 → `H_m = 1`。需要文本匹配检测（L2 content 子串是否在 modelText 中）。

**优点**：完全复用 V5 公式，零改造成本。
**缺点**：向量召回的"相关性"比关键词命中弱，可能需要调低 `B_u`（用户基础奖励）。

### 7.3 方案 B：L2 专用 Decay（固定 base 衰减）

不依赖 S_u/S_m，每轮固定衰减：

```ts
D_l2 = baseDecay / √I;  // baseDecay 固定，I 决定速率
```

被召回那轮 D=0（不衰减），未被召回那轮 D=baseDecay/√I。

**优点**：简单，行为可预测。
**缺点**：失去"久别重逢"奖励曲线，且偏离 DMAE 标准公式。

### 7.4 方案 C：混合——召回回响

被召回那轮给一个"虚拟命中"（S_u=0 + Reward），之后几轮 S_u 正常 ++，但给一个衰减的"回响"虚拟 S_u 偏移：

```ts
// 被召回后 N 轮内，S_u_eff = max(S_u_real, recallEcho - turnsSinceRecall)
```

**优点**：兼顾久别重逢 + 向量召回语义。
**缺点**：复杂度高，引入新参数。

### 7.5 推荐

**方案 A**（向量召回 = 用户命中）。理由：
1. 零公式改造，完全复用 V5
2. 语义合理（向量召回 = 用户当前话题相关 = "命中"）
3. "久别重逢"曲线对 L2 也有意义（长期未被召回的 L2 再次被召回时，Reward 应更高）
4. 只需调参（`B_u` 可能要从 20 降到 ~10，因为向量召回比字面命中弱）

---

## 8. 工程实现清单

### Phase 1：V4→V5.1 升级

| # | 文件 | 改动 |
|---|---|---|
| 1.1 | [worldbook.ts](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts) | `DmaeParams` 加 `repeatRho/satPower/repeatWindow/wakeBonus` |
| 1.2 | 同上 | `EntryState` 加 `recentUserHits: number[]` |
| 1.3 | 同上 | `RewardContext` 加 `recentHitCount?: number` |
| 1.4 | 同上 | `DefaultRewardStrategy.userReward` 加 G_sat × G_repeat |
| 1.5 | 同上 | `updateActivation` 拆分 Lifecycle Phase（Wake-Up 初值改写）+ Update Phase |
| 1.6 | 同上 | Wake-Up 从 `max(aNew, I)` 改为 `A_init = T_active + B_w`（初值改写） |
| 1.7 | 同上 | Archived skip update（未命中的 Archived 跳过） |
| 1.8 | 同上 | `recentUserHits` 窗口维护 + push |
| 1.9 | [worldbook-constants.ts](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook-constants.ts) | 确认/新增 V5 相关常量 |
| 1.10 | worldbook 测试 | 更新 V5 行为断言 |
| 1.11 | `src/main/sim/` | Simulator 跑 `coffee-lifecycle` / `four-tier-mix` / `dormant-rescue` 验证 |

### Phase 2：DmaeEntry 抽象

| # | 文件 | 改动 |
|---|---|---|
| 2.1 | 新建 `dmae-types.ts` 或并入 worldbook.ts | `DmaeEntry` 接口 |
| 2.2 | [worldbook.ts](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/worldbook.ts) | `WorldbookEntry implements DmaeEntry`（已有字段，只需声明 implements） |
| 2.3 | `WorldbookManager` | 泛型化为 `DmaeManager<T extends DmaeEntry>` 或保持原名 |
| 2.4 | [rag/index.ts](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/rag/index.ts) | 导出调整 |

### Phase 3：L2 DMAE 接入

| # | 文件 | 改动 |
|---|---|---|
| 3.1 | [orchestrator/index.ts:33](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/orchestrator/index.ts#L33) | topK 5 → 4 |
| 3.2 | [orchestrator/index.ts:33](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/orchestrator/index.ts#L33) | 修正过时注释 "top-3" → "top-4" |
| 3.3 | 新建 `l2-dmae-manager.ts` 或扩展 `DmaeManager` | L2 DMAE 状态管理（独立 DmaeParams 实例，decayAlpha≈3.2） |
| 3.4 | [memory-store.ts](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/memory/memory-store.ts) | L2 DMAE state 持久化（`l2DmaeStates` Map + JSON 同步） |
| 3.5 | [memory-types.ts](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/memory/memory-types.ts) | `L2Memory` 加 DMAE 相关字段（或独立 state 表） |
| 3.6 | [orchestrator/index.ts](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/orchestrator/index.ts) | `buildMemoryInjection`：top-4 召回后赋 I 值 + markRecalled；DMAE 热层驻留 L2 注入 |
| 3.7 | [call-prompt-builder.ts:38](file:///c:/Users/13575/Documents/live2D-Cyrene/src/main/call/call-prompt-builder.ts#L38) | 每轮调用 `l2DmaeManager.updateActivation(userText, modelText)` |
| 3.8 | L2 keywords 提取 | L2 content 分词 或 evidence entities 提取为 keywords（用于 H_m 检测） |

### Phase 4：参数校准

| # | 文件 | 改动 |
|---|---|---|
| 4.1 | `src/main/sim/` | 新增 L2 working memory 场景（4 档 I 值 + 2-4 轮跌破验证） |
| 4.2 | L2 DmaeParams | 根据 Simulator 结果校准 `decayAlpha` / `B_u` / I 值梯度 |

---

## 9. 验证计划

### 9.1 类型检查

```bash
npx tsc --noEmit -p tsconfig.main.json
```

### 9.2 单元测试

```bash
npx vitest run src/main/rag          # worldbook / DMAE V5 升级
npx vitest run src/main/memory       # L2 DMAE 接入
npx vitest run src/main/orchestrator # buildMemoryInjection
```

### 9.3 Simulator 场景

| 场景 | 验证点 |
|---|---|
| `coffee-lifecycle`（30 轮） | V5 升级后单条目生命周期不变（Wake-Up 重构不破坏现有行为） |
| `four-tier-mix`（100 轮） | 4 档 I 值共存不霸榜 |
| `dormant-rescue`（10 轮） | Archived 再唤醒正常 |
| **新增** `l2-working-memory`（20 轮） | L2 top-4 召回后，位次1=4轮 / 位次4=2轮 跌破 Dormant |

### 9.4 关键不变量验证

- [ ] V5 §9.1：模型不能独立激活 Dormant/Archived（R_m gating 读 aOld）
- [ ] V5 §9.2：长期无用户命中最终归零
- [ ] V5 §9.3：用户拥有唯一再激活权
- [ ] V5 §3.6：I 只参与 Decay 分母，不放大奖励
- [ ] L2 DMAE state 持久化：重启后 activation 不回 0
- [ ] L2 status=archived 不进 DMAE（正交隔离）

---

## 附录 A：V5 白皮书关键章节引用

| 白皮书章节 | 关键内容 | 本文档对应 |
|---|---|---|
| §5.4 饱和抑制 | `G_sat = (1-A/A_max)^p` | §4.3 |
| §5.5 重复抑制 | `G_repeat = 1/(1+ρ·n_w)` | §4.4 |
| §5.6 有效奖励 | `R_u* = R_u × G_sat × G_repeat` | §4.5 |
| §5.9 衰减 | `D = (α·S_u²+β·S_m²)/√I` | §6.2 |
| §7.4 Wake-Up | `A_init = T_active + B_w`（初值改写） | §4.6 |
| §7.4.4 Reward gating | R_m 读 aOld 不读 A_init | §4.6 |
| §11.2 两阶段流程 | Lifecycle Phase + Update Phase | §4.6, §4.7 |
| 附录 B 默认参数 | 12 个参数默认值 | §4.1 |
| 附录 D.1 I 值留白 | I 由上游提供，DMAE 不生成 | §5.2, §6.3 |

## 附录 B：V4 与 V5.1 参数对照

| 参数 | V4 默认 | V5.1 默认 | 变化 |
|---|---|---|---|
| maxScore | 100 | 100 | 不变 |
| promptThreshold | 30 | 30 | 不变 |
| userRewardBase | 20 | 20 | 不变 |
| wakeGamma | 0.5 | 0.5 | 不变 |
| modelRewardBase | 8 | 8 | 不变 |
| wakeLambda | 0.3 | 0.3 | 不变 |
| decayAlpha | **1.5** | **1.0** | ↓（V5 附录 B 默认 1.0；L2 专用 ~3.2） |
| decayBeta | **0.3** | **0.2** | ↓（V5 附录 B 默认 0.2） |
| repeatRho | — | **0.5** | 新增 |
| satPower | — | **2** | 新增 |
| repeatWindow | — | **6** | 新增 |
| wakeBonus | — | **5** | 新增 |

> ⚠️ V4 的 `decayAlpha=1.5` 是针对"8 轮跌破"反推的；V5 默认改回 1.0（附录 B），L2 专用实例用 ~3.2（针对"2-4 轮跌破"反推）。升级时 worldbook 的 `DEFAULT_DMAE_PARAMS` 是否同步改为 V5 默认值，需确认（可能影响现有 worldbook 行为，建议保留 V4 值或跑 Simulator 验证）。

## 附录 C：L2 专用 DmaeParams（建议）

```ts
const L2_DMAE_PARAMS: DmaeParams = {
  maxScore: 100,
  promptThreshold: 30,
  userRewardBase: 10,      // ↓ 从 20 降到 10（向量召回比字面命中弱）
  wakeGamma: 0.5,
  modelRewardBase: 4,      // ↓ 从 8 降到 4（L2 模型命中更弱）
  wakeLambda: 0.3,
  decayAlpha: 3.2,         // ↑ 从 1.5 升到 3.2（L2 衰减更快，2-4 轮跌破）
  decayBeta: 0.2,
  repeatRho: 0.5,
  satPower: 2,
  repeatWindow: 6,
  wakeBonus: 5,
};

const L2_I_BY_RANK = [4, 8, 8, 1];  // 位次 1/2/3/4 的 I 值（待 Simulator 校准）
```
