// V5 L2 Working Memory 场景：
// 验收：
//   - 第 1 轮 recall top-4 → 4 条 activation 立即跳到 35（wake-up）以上，进入 active
//   - 连续 2~4 轮沉默后，位次 4 的 L2 率先 archived（I=1）
//   - 位次 1 的 L2 在第 4 轮沉默后 archived（I=36）
//   - 第 6 轮再次 recall 一条已 archived L2 → 触发 wake-up 回到 35
//
// 此场景直接面向 L2Memory，模拟向量召回 top-4 作为 userHit。
import type { Round } from "../sim-types";

export interface L2Fixture {
  id: string;
  content: string;
  triggerText: string;
  keywords: string[];
}

export const L2_FIXTURES: L2Fixture[] = [
  {
    id: "l2_coffee",
    content: "用户每天早上都要喝咖啡",
    triggerText: "我每天早上都要喝咖啡",
    keywords: ["咖啡", "早上", "喝"],
  },
  {
    id: "l2_cat",
    content: "用户养了一只叫咪咪的猫",
    triggerText: "我养了只猫叫咪咪",
    keywords: ["猫", "咪咪"],
  },
  {
    id: "l2_run",
    content: "用户习惯周末去公园跑步",
    triggerText: "我周末去公园跑步",
    keywords: ["跑步", "公园", "周末"],
  },
  {
    id: "l2_music",
    content: "用户最近沉迷爵士乐",
    triggerText: "我最近很喜欢爵士乐",
    keywords: ["爵士", "音乐"],
  },
  {
    id: "l2_rain",
    content: "用户喜欢下雨天待在家里",
    triggerText: "我喜欢下雨天待在家",
    keywords: ["下雨", "家"],
  },
];

export const L2_ROUNDS: Round[] = [
  // R1: 用户提起咖啡 → 向量召回 top-4（coffee, cat, run, music）
  { index: 0, userText: "早上好，我刚喝完咖啡，准备带咪咪去公园跑步", modelText: "今天也是活力满满的一天呢，爵士乐还要听吗？" },
  // R2: 用户继续围绕 top-4，仍有命中
  { index: 1, userText: "对，跑步时我一般听爵士", modelText: "爵士配跑步，节奏刚好。" },
  // R3: 继续命中 top-4（衰减开始累积）
  { index: 2, userText: "咪咪也很喜欢公园", modelText: "猫咪的确喜欢户外。" },
  // R4: 偏离话题 → 4 条 L2 进入纯衰减
  { index: 3, userText: "今天工作好忙", modelText: "加油呀。" },
  // R5: 继续沉默
  { index: 4, userText: "午饭吃什么好呢", modelText: "想吃什么呢？" },
  // R6: 召回 rain（此时 music 应该已 archived，观察 wake-up）
  { index: 5, userText: "今天下雨了， rain 场景被召回", modelText: "下雨天适合在家。" },
  // R7~R10: 继续沉默，观察各条目的衰减曲线
  { index: 6, userText: "嗯", modelText: "" },
  { index: 7, userText: "哦", modelText: "" },
  { index: 8, userText: "行", modelText: "" },
  { index: 9, userText: "好", modelText: "" },
];
