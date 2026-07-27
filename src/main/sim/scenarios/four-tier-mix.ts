// 場景 2：four-tier-mix（100 輪）
// 4 檔 IntrinsicValue（90/70/45/15）+ 1 permanent
// 每輪從 4 檔中按權重隨機選 user 提什麼；1/3 概率 model 複述已激活條目
import type { Round, Scenario } from "../sim-types";
import { parseFixtureMarkdown } from "./fixture-parser";

// Fixture 內聯：sim 專用，編譯後隨 JS 走（不依賴外部 .md 複製）
const MIX_FIXTURE = `## 測試常駐
- 觸發詞: 常駐測試, fixture_permanent
- 常駐: 是
- 內在價值: 100
- 優先級: 200

fixture permanent 條目，驗證旁路（始終注入，不進 DMAE）。
---

## 昔漣主角
- 觸發詞: 昔漣, Cyrene, 迷迷, 翁法羅斯之心
- 內在價值: 90
- 優先級: 200

昔漣是核心角色。
---

## 哀麗秘榭
- 觸發詞: 哀麗秘榭, 故鄉, 麥田, 鞦韆
- 內在價值: 70
- 優先級: 150

重要場景記憶。
---

## 咖啡
- 觸發詞: 咖啡, latte, 美式, espresso
- 內在價值: 45
- 優先級: 100

用戶日常喜好。
---

## Blender
- 觸發詞: Blender, blender, 建模, 渲染
- 內在價值: 45
- 優先級: 100

用戶 3D 創作工具。
---

## 貓
- 觸發詞: 貓, 小貓, 喵, 擼貓
- 內在價值: 45
- 優先級: 100

生活興趣。
---

## 星穹鐵道
- 觸發詞: 星穹鐵道, 星鐵, 穹, 列車
- 內在價值: 45
- 優先級: 100

用戶玩的遊戲。
---

## 今天下午
- 觸發詞: 今天下午, 剛才, 剛剛
- 內在價值: 15
- 優先級: 80

臨時事件。
---

## 上週電影
- 觸發詞: 上週, 上次, 電影, 影院
- 內在價值: 15
- 優先級: 80

臨時事件。
---

## 天氣
- 觸發詞: 天氣, 下雨, 出太陽, 陰天
- 內在價值: 15
- 優先級: 80

日常閒聊。
---
`;

// 4 檔（I=90/70/45/15）+ 1 permanent
// 按權重選擇（高 0.2 / 中-高 0.3 / 中 0.3 / 低 0.2）
// 關鍵詞池：每檔給一組（用真實 fixture 裡條目的觸發詞子集）
const TIER_KEYWORDS: Array<{ tier: string; I: number; weight: number; keywords: string[] }> = [
  // I=90 關鍵詞池：去掉"昔漣""Cyrene"（這些是 soul 層常用暱稱，worldbook 不應通過它們觸發；
  // 用戶日常叫她"昔漣"應走 soul 的人格，而非 worldbook 的身世條目）。
  // 保留"PHILIA093""翁法羅斯之心""權杖核心""最初形態""你從哪來"等純身世關鍵詞。
  // 注：這些關鍵詞必須在對應 .md 條目的"觸發詞"字段裡存在，否則觸發不到。
  { tier: "high",     I: 90, weight: 0.2, keywords: ["迷迷", "PHILIA093", "翁法羅斯之心", "權杖核心", "最初形態", "你從哪來", "德謬歌"] },
  { tier: "mid-high", I: 70, weight: 0.3, keywords: ["哀麗秘榭", "故鄉", "麥田"] },
  { tier: "mid",      I: 45, weight: 0.3, keywords: ["咖啡", "Blender", "貓", "星穹鐵道"] },
  { tier: "low",      I: 15, weight: 0.2, keywords: ["今天下午", "天氣", "上週"] },
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

// 簡易 LCG 隨機數生成器（保證同 seed 可復現）
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
  // 累計每個 tier 被提過哪些關鍵詞，供 model 複述
  const recentHits: string[] = [];

  for (let i = 0; i < totalRounds; i++) {
    // 30% 概率沉默輪（讓條目自然衰減）
    if (rng() < 0.15 && i > 0) {
      rounds.push({ index: i, userText: "嗯", modelText: "", note: "silence" });
      continue;
    }
    const { tier, kw } = pickKeyword(rng);
    // 1/3 概率 model 複述上一輪/本輪激活的關鍵詞
    let modelText = "";
    if (rng() < 0.33 && recentHits.length > 0) {
      const mk = recentHits[Math.floor(rng() * recentHits.length)];
      modelText = `對，${mk}，我同意。`;
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
  description: "100 輪：4 檔 I（90/70/45/15）+ 1 permanent，驗證不霸榜 / 快速歸 0 / 久別復活 / model 不加分",
  buildEntries: () => parseFixtureMarkdown(MIX_FIXTURE, "mix"),
  buildRounds: () => buildMixRounds(100, 42),
};
