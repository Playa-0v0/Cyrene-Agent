// 場景 3：dormant-rescue（10 輪）
// 專測 v3.4 bug 修復：Dormant 狀態下用戶再提，A 應立即回升而非繼續下降。
// 修復前：userHit 不重置 ms → ms 累積 → decay > reward → A 繼續掉到 Archived 才能被 floor 救回
// 修復後：userHit 重置 ms → ms=0 → decay 下降 → reward 主導 → A 回升
import type { Round, Scenario } from "../sim-types";
import { parseFixtureMarkdown } from "./fixture-parser";

const RESCUE_FIXTURE = `## 咖啡
- 觸發詞: 咖啡
- 內在價值: 60
- 優先級: 100

測試用。
---

## 白厄
- 觸發詞: 白厄
- 內在價值: 90
- 優先級: 150

對比用。
`;

// R1: user 提咖啡 → A 跳到 60 (floor)
// R2~R8: 沉默 7 輪 → A 衰減，預期掉到 Dormant (A<30)
// R9: user 再提咖啡，model 不提 → 修復後 A 應回升；修復前 A 會繼續下降
// R10: 再沉默一輪觀察趨勢
const RESCUE_ROUNDS: Round[] = [
  { index: 0,  userText: "今天想喝咖啡",   modelText: "",               note: "首命中→floor 60" },
  { index: 1,  userText: "嗯",             modelText: "",               note: "沉默" },
  { index: 2,  userText: "好的",           modelText: "",               note: "沉默" },
  { index: 3,  userText: "白厄怎麼樣",      modelText: "白厄很好。",     note: "沉默 coffee" },
  { index: 4,  userText: "嗯",             modelText: "",               note: "沉默" },
  { index: 5,  userText: "天氣不錯",       modelText: "是呢。",         note: "沉默" },
  { index: 6,  userText: "嗯",             modelText: "",               note: "沉默" },
  { index: 7,  userText: "好吧",           modelText: "",               note: "沉默——coffee 應已 Dormant" },
  { index: 8,  userText: "還是想喝咖啡",   modelText: "",               note: "★ 救援點：A 必須回升" },
  { index: 9,  userText: "嗯",             modelText: "",               note: "觀察趨勢" },
];

export const dormantRescue: Scenario = {
  name: "dormant-rescue",
  description: "10 輪：Dormant 救援測試——R9 user 再提時 A 必須回升（驗證 ms 重置修復）",
  buildEntries: () => parseFixtureMarkdown(RESCUE_FIXTURE, "rescue"),
  buildRounds: () => RESCUE_ROUNDS,
};
