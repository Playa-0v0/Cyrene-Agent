// V5 L2 Working Memory Simulator Runner
// 直接复用通用 DmaeManager + L2 适配器，不依赖 memory.json 持久化。
import { DmaeManager, DefaultRewardStrategy, QuadraticResistanceDecay, deriveState } from "../rag/worldbook";
import type { L2Fixture } from "./scenarios/l2-working-memory";
import { L2_FIXTURES, L2_ROUNDS } from "./scenarios/l2-working-memory";
import { L2_DMAE_PARAMS, L2_INTRINSIC_BY_RANK } from "../memory/l2-dmae-manager";
import type { L2Memory } from "../memory/memory-types";

interface L2DmaeEntry {
  id: string;
  keywords: string[];
  intrinsicValue: number;
  permanent: boolean;
  enabled: boolean;
  l2: L2Memory;
}

function adapt(l2: L2Memory, intrinsicValue: number): L2DmaeEntry {
  return {
    id: l2.id,
    keywords: l2.keywords ?? [],
    intrinsicValue,
    permanent: l2.isPinned,
    enabled: l2.status !== "archived",
    l2,
  };
}

function buildL2Memories(fixtures: L2Fixture[]): L2Memory[] {
  return fixtures.map((f) => ({
    ...f,
    sourceConversationId: "sim",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    weight: 0,
    isPinned: false,
    status: "active" as const,
  }));
}

// 模拟向量召回：简单按 keywords 重叠度返回 top-K，仅召回至少命中 1 个关键词的条目
function recallTopK(userText: string, l2List: L2Memory[], k = 4): string[] {
  const scored = l2List.map((l2) => {
    const hits = (l2.keywords ?? []).filter((kw) => userText.includes(kw)).length;
    return { id: l2.id, score: hits };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, k).map((s) => s.id);
}

function runScenario(): void {
  const mgr = new DmaeManager<L2DmaeEntry>({
    params: L2_DMAE_PARAMS,
    rewardStrategy: new DefaultRewardStrategy<L2DmaeEntry>(),
    decayStrategy: new QuadraticResistanceDecay<L2DmaeEntry>(),
    debug: false,
  });

  const l2List = buildL2Memories(L2_FIXTURES);
  mgr.initEntries(l2List.map((l2) => adapt(l2, 0)));

  // 跟踪每个 L2 当前的 I（由召回器按位次临时设置）
  const intrinsicValues = new Map<string, number>();

  console.log("V5 L2 Working Memory Simulator");
  console.log("Params:", JSON.stringify(L2_DMAE_PARAMS));
  console.log("I gradient by rank:", L2_INTRINSIC_BY_RANK);
  console.log("=".repeat(80));

  for (const round of L2_ROUNDS) {
    // 1. 模拟向量召回 top-4
    const recalled = recallTopK(round.userText, l2List, 4);

    // 2. 按位次设置 I，archived 召回条目 wake-up
    for (let i = 0; i < recalled.length; i++) {
      const id = recalled[i];
      const I = L2_INTRINSIC_BY_RANK[Math.min(i, L2_INTRINSIC_BY_RANK.length - 1)];
      intrinsicValues.set(id, I);
      const st = mgr.getState(id);
      if (st && deriveState(st.activation, L2_DMAE_PARAMS.promptThreshold) === "Archived") {
        mgr.setState(id, {
          ...st,
          activation: Math.min(L2_DMAE_PARAMS.maxScore, L2_DMAE_PARAMS.promptThreshold + L2_DMAE_PARAMS.wakeBonus),
        });
      }
    }

    // 3. 构建 DMAE entries（包含当前 I）
    const entries = l2List.map((l2) => {
      const I = intrinsicValues.get(l2.id) ?? 0;
      return adapt(l2, I);
    });

    // 4. 执行 DMAE 更新
    mgr.updateActivation(entries, round.userText, round.modelText, round.index);

    // 5. 打印本轮状态
    console.log(`\n--- Round ${round.index + 1} ---`);
    console.log(`User: ${round.userText}`);
    console.log(`Recalled: [${recalled.join(", ")}]`);
    for (const l2 of l2List) {
      const st = mgr.getState(l2.id)!;
      const state = deriveState(st.activation, L2_DMAE_PARAMS.promptThreshold);
      const I = intrinsicValues.get(l2.id) ?? 0;
      console.log(
        `  ${l2.id.padEnd(12)} A=${st.activation.toFixed(1).padStart(5)} US=${st.userSilence.toString().padStart(2)} MS=${st.modelSilence.toString().padStart(2)} I=${I.toString().padStart(2)} state=${state}`,
      );
    }
  }
}

runScenario();
