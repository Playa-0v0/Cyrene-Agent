// 场景 3：dormant-rescue（10 轮）
// 专测 v3.4 bug 修复：Dormant 状态下用户再提，A 应立即回升而非继续下降。
// 修复前：userHit 不重置 ms → ms 累积 → decay > reward → A 继续掉到 Archived 才能被 floor 救回
// 修复后：userHit 重置 ms → ms=0 → decay 下降 → reward 主导 → A 回升
import type { Round, Scenario } from "../sim-types";
import { parseFixtureMarkdown } from "./fixture-parser";

const RESCUE_FIXTURE = `## 咖啡
- 触发词: 咖啡
- 内在价值: 60
- 优先级: 100

测试用。
---

## 白厄
- 触发词: 白厄
- 内在价值: 90
- 优先级: 150

对比用。
`;

// R1: user 提咖啡 → A 跳到 60 (floor)
// R2~R8: 沉默 7 轮 → A 衰减，预期掉到 Dormant (A<30)
// R9: user 再提咖啡，model 不提 → 修复后 A 应回升；修复前 A 会继续下降
// R10: 再沉默一轮观察趋势
const RESCUE_ROUNDS: Round[] = [
  { index: 0,  userText: "今天想喝咖啡",   modelText: "",               note: "首命中→floor 60" },
  { index: 1,  userText: "嗯",             modelText: "",               note: "沉默" },
  { index: 2,  userText: "好的",           modelText: "",               note: "沉默" },
  { index: 3,  userText: "白厄怎么样",      modelText: "白厄很好。",     note: "沉默 coffee" },
  { index: 4,  userText: "嗯",             modelText: "",               note: "沉默" },
  { index: 5,  userText: "天气不错",       modelText: "是呢。",         note: "沉默" },
  { index: 6,  userText: "嗯",             modelText: "",               note: "沉默" },
  { index: 7,  userText: "好吧",           modelText: "",               note: "沉默——coffee 应已 Dormant" },
  { index: 8,  userText: "还是想喝咖啡",   modelText: "",               note: "★ 救援点：A 必须回升" },
  { index: 9,  userText: "嗯",             modelText: "",               note: "观察趋势" },
];

export const dormantRescue: Scenario = {
  name: "dormant-rescue",
  description: "10 轮：Dormant 救援测试——R9 user 再提时 A 必须回升（验证 ms 重置修复）",
  buildEntries: () => parseFixtureMarkdown(RESCUE_FIXTURE, "rescue"),
  buildRounds: () => RESCUE_ROUNDS,
};
