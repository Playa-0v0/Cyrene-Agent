// 场景 2：four-tier-mix（100 轮）
// 4 档 IntrinsicValue（90/70/45/15）+ 1 permanent
// 每轮从 4 档中按权重随机选 user 提什么；1/3 概率 model 复述已激活条目
import type { Round, Scenario } from "../sim-types";
import { parseFixtureMarkdown } from "./fixture-parser";

// Fixture 内联：sim 专用，编译后随 JS 走（不依赖外部 .md 复制）
const MIX_FIXTURE = `## 测试常驻
- 触发词: 常驻测试, fixture_permanent
- 常驻: 是
- 内在价值: 100
- 优先级: 200

fixture permanent 条目，验证旁路（始终注入，不进 DMAE）。
---

## 昔涟主角
- 触发词: 昔涟, Cyrene, 迷迷, 翁法罗斯之心
- 内在价值: 90
- 优先级: 200

昔涟是核心角色。
---

## 哀丽秘榭
- 触发词: 哀丽秘榭, 故乡, 麦田, 秋千
- 内在价值: 70
- 优先级: 150

重要场景记忆。
---

## 咖啡
- 触发词: 咖啡, latte, 美式, espresso
- 内在价值: 45
- 优先级: 100

用户日常喜好。
---

## Blender
- 触发词: Blender, blender, 建模, 渲染
- 内在价值: 45
- 优先级: 100

用户 3D 创作工具。
---

## 猫
- 触发词: 猫, 小猫, 喵, 撸猫
- 内在价值: 45
- 优先级: 100

生活兴趣。
---

## 星穹铁道
- 触发词: 星穹铁道, 星铁, 穹, 列车
- 内在价值: 45
- 优先级: 100

用户玩的游戏。
---

## 今天下午
- 触发词: 今天下午, 刚才, 刚刚
- 内在价值: 15
- 优先级: 80

临时事件。
---

## 上周电影
- 触发词: 上周, 上次, 电影, 影院
- 内在价值: 15
- 优先级: 80

临时事件。
---

## 天气
- 触发词: 天气, 下雨, 出太阳, 阴天
- 内在价值: 15
- 优先级: 80

日常闲聊。
---
`;

// 4 档（I=90/70/45/15）+ 1 permanent
// 按权重选择（高 0.2 / 中-高 0.3 / 中 0.3 / 低 0.2）
// 关键词池：每档给一组（用真实 fixture 里条目的触发词子集）
const TIER_KEYWORDS: Array<{ tier: string; I: number; weight: number; keywords: string[] }> = [
  // I=90 关键词池：必须与 fixture "昔涟主角" 条目的触发词字段一致，否则生成 rounds 也触发不到。
  { tier: "high",     I: 90, weight: 0.2, keywords: ["昔涟", "Cyrene", "迷迷", "翁法罗斯之心"] },
  { tier: "mid-high", I: 70, weight: 0.3, keywords: ["哀丽秘榭", "故乡", "麦田"] },
  { tier: "mid",      I: 45, weight: 0.3, keywords: ["咖啡", "Blender", "猫", "星穹铁道"] },
  { tier: "low",      I: 15, weight: 0.2, keywords: ["今天下午", "天气", "上周"] },
];

function pickKeyword(rng: () => number): { tier: string; kw: string } {
  const r = rng();
  let acc = 0;
  for (const t of TIER_KEYWORDS) {
    acc += t.weight;
    if (r < acc) {
      const kw = t.keywords[Math.floor(rng() * t.keywords.length)];
      return { tier: t.tier, kw };
    }
  }
  const last = TIER_KEYWORDS[TIER_KEYWORDS.length - 1];
  return { tier: last.tier, kw: last.keywords[0] };
}

// 简易 LCG 随机数生成器（保证同 seed 可复现）
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function buildMixRounds(totalRounds: number = 100, seed: number = 42): Round[] {
  const rng = makeRng(seed);
  const rounds: Round[] = [];
  // 累计每个 tier 被提过哪些关键词，供 model 复述
  const recentHits: string[] = [];

  for (let i = 0; i < totalRounds; i++) {
    // 30% 概率沉默轮（让条目自然衰减）
    if (rng() < 0.15 && i > 0) {
      rounds.push({ index: i, userText: "嗯", modelText: "", note: "silence" });
      continue;
    }
    const { tier, kw } = pickKeyword(rng);
    // 1/3 概率 model 复述上一轮/本轮激活的关键词
    let modelText = "";
    if (rng() < 0.33 && recentHits.length > 0) {
      const mk = recentHits[Math.floor(rng() * recentHits.length)];
      modelText = `对，${mk}，我同意。`;
    }
    rounds.push({
      index: i,
      userText: `聊${kw}`,
      modelText,
      note: `tier=${tier} kw=${kw}`,
    });
    recentHits.push(kw);
    if (recentHits.length > 8) recentHits.shift();
  }
  return rounds;
}

export const fourTierMix: Scenario = {
  name: "four-tier-mix",
  description: "100 轮：4 档 I（90/70/45/15）+ 1 permanent，验证不霸榜 / 快速归 0 / 久别复活 / model 不加分",
  buildEntries: () => parseFixtureMarkdown(MIX_FIXTURE, "mix"),
  buildRounds: () => buildMixRounds(100, 42),
};
