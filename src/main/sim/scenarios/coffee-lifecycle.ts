// 场景 1：coffee-lifecycle（30 轮）
// 验收：R1 跳到 45（I=45 的 floor 触发），R5 跌破 30（Dormant），R10~12 归 0（Archived），
//       R16 再提 → 复活跳回 45+，R17~30 在 30~90 区间震荡。
import type { Round, Scenario } from "../sim-types";
import { parseFixtureMarkdown } from "./fixture-parser";

const COFFEE_FIXTURE = `## 咖啡
- 触发词: 咖啡, latte, 美式
- 内在价值: 45
- 优先级: 100

用户日常喜好，间接触发。
---

## 白厄
- 触发词: 白厄, Phainon
- 内在价值: 90
- 优先级: 150

核心配角，用于对比。
`;

const COFFEE_ROUNDS: Round[] = [
  // R1~R3: 连提咖啡
  { index: 0, userText: "今天想喝咖啡", modelText: "好呀，要 latte 还是美式？" },
  { index: 1, userText: "还是咖啡吧", modelText: "咖啡咖啡咖啡～" },
  { index: 2, userText: "咖啡咖啡", modelText: "" },
  // R4~R8: 沉默 5 轮，model 提白厄（让 coffee 沉默）
  { index: 3, userText: "白厄最近怎么样", modelText: "白厄最近很忙。" },
  { index: 4, userText: "嗯", modelText: "" },
  { index: 5, userText: "今天天气不错", modelText: "是呢。" },
  { index: 6, userText: "嗯", modelText: "" },
  { index: 7, userText: "那好吧", modelText: "" },
  // R9~R12: 提其他话题，coffee 继续沉默
  { index: 8, userText: "白厄", modelText: "白厄在呢。" },
  { index: 9, userText: "Blender 学了吗", modelText: "没呢。" },
  { index: 10, userText: "那猫呢", modelText: "猫很好。" },
  { index: 11, userText: "好吧", modelText: "" },
  // R13~R15: 再沉默
  { index: 12, userText: "嗯", modelText: "" },
  { index: 13, userText: "好的", modelText: "" },
  { index: 14, userText: "那就这样", modelText: "" },
  // R16: 复活点——再提咖啡（应当触发 Archived→Active floor 跳到 45）
  { index: 15, userText: "还是想喝咖啡", modelText: "好呀～" },
  // R17~R30: 随机混合
  { index: 16, userText: "猫呢", modelText: "" },
  { index: 17, userText: "咖啡", modelText: "" },
  { index: 18, userText: "天气真好", modelText: "是呢。" },
  { index: 19, userText: "嗯", modelText: "" },
  { index: 20, userText: "白厄白厄", modelText: "" },
  { index: 21, userText: "今天下午", modelText: "" },
  { index: 22, userText: "咖啡", modelText: "" },
  { index: 23, userText: "猫猫猫", modelText: "" },
  { index: 24, userText: "嗯", modelText: "" },
  { index: 25, userText: "好", modelText: "" },
  { index: 26, userText: "Blender", modelText: "" },
  { index: 27, userText: "咖啡", modelText: "" },
  { index: 28, userText: "天气", modelText: "" },
  { index: 29, userText: "嗯", modelText: "" },
];

export const coffeeLifecycle: Scenario = {
  name: "coffee-lifecycle",
  description: "30 轮：单条目咖啡从触发→Dormant→Archived→复活→震荡",
  buildEntries: () => parseFixtureMarkdown(COFFEE_FIXTURE, "coffee-fixture"),
  buildRounds: () => COFFEE_ROUNDS,
};
