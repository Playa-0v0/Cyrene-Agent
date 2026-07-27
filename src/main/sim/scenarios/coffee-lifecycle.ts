// 場景 1：coffee-lifecycle（30 輪）
// 驗收：R1 跳到 45（I=45 的 floor 觸發），R5 跌破 30（Dormant），R10~12 歸 0（Archived），
//       R16 再提 → 復活跳回 45+，R17~30 在 30~90 區間震盪。
import type { Round, Scenario } from "../sim-types";
import { parseFixtureMarkdown } from "./fixture-parser";

const COFFEE_FIXTURE = `## 咖啡
- 觸發詞: 咖啡, latte, 美式
- 內在價值: 45
- 優先級: 100

用戶日常喜好，間接觸發。
---

## 白厄
- 觸發詞: 白厄, Phainon
- 內在價值: 90
- 優先級: 150

核心配角，用於對比。
`;

const COFFEE_ROUNDS: Round[] = [
  // R1~R3: 連提咖啡
  { index: 0, userText: "今天想喝咖啡", modelText: "好呀，要 latte 還是美式？" },
  { index: 1, userText: "還是咖啡吧", modelText: "咖啡咖啡咖啡～" },
  { index: 2, userText: "咖啡咖啡", modelText: "" },
  // R4~R8: 沉默 5 輪，model 提白厄（讓 coffee 沉默）
  { index: 3, userText: "白厄最近怎麼樣", modelText: "白厄最近很忙。" },
  { index: 4, userText: "嗯", modelText: "" },
  { index: 5, userText: "今天天氣不錯", modelText: "是呢。" },
  { index: 6, userText: "嗯", modelText: "" },
  { index: 7, userText: "那好吧", modelText: "" },
  // R9~R12: 提其他話題，coffee 繼續沉默
  { index: 8, userText: "白厄", modelText: "白厄在呢。" },
  { index: 9, userText: "Blender 學了嗎", modelText: "沒呢。" },
  { index: 10, userText: "那貓呢", modelText: "貓很好。" },
  { index: 11, userText: "好吧", modelText: "" },
  // R13~R15: 再沉默
  { index: 12, userText: "嗯", modelText: "" },
  { index: 13, userText: "好的", modelText: "" },
  { index: 14, userText: "那就這樣", modelText: "" },
  // R16: 復活點——再提咖啡（應當觸發 Archived→Active floor 跳到 45）
  { index: 15, userText: "還是想喝咖啡", modelText: "好呀～" },
  // R17~R30: 隨機混合
  { index: 16, userText: "貓呢", modelText: "" },
  { index: 17, userText: "咖啡", modelText: "" },
  { index: 18, userText: "天氣真好", modelText: "是呢。" },
  { index: 19, userText: "嗯", modelText: "" },
  { index: 20, userText: "白厄白厄", modelText: "" },
  { index: 21, userText: "今天下午", modelText: "" },
  { index: 22, userText: "咖啡", modelText: "" },
  { index: 23, userText: "貓貓貓", modelText: "" },
  { index: 24, userText: "嗯", modelText: "" },
  { index: 25, userText: "好", modelText: "" },
  { index: 26, userText: "Blender", modelText: "" },
  { index: 27, userText: "咖啡", modelText: "" },
  { index: 28, userText: "天氣", modelText: "" },
  { index: 29, userText: "嗯", modelText: "" },
];

export const coffeeLifecycle: Scenario = {
  name: "coffee-lifecycle",
  description: "30 輪：單條目咖啡從觸發→Dormant→Archived→復活→震盪",
  buildEntries: () => parseFixtureMarkdown(COFFEE_FIXTURE, "coffee-fixture"),
  buildRounds: () => COFFEE_ROUNDS,
};
