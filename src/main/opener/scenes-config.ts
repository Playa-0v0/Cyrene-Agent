// 8 場景配置：id / todayFiredFlag / cooldownMs / recentAvoidN
// 數值對齊 spec 第 5.1 節 manifest schema。

import type { SceneId } from "./opener-types";

export interface SceneConfig {
  id: SceneId;
  todayFiredFlag: string | null;
  cooldownMs: number;
  recentAvoidN: number;
}

export const SCENE_CONFIGS: SceneConfig[] = [
  { id: "morning",         todayFiredFlag: "morning",    cooldownMs: 36000000, recentAvoidN: 0 },
  { id: "late_night",      todayFiredFlag: "late_night", cooldownMs: 7200000,  recentAvoidN: 2 },
  { id: "idle_daze",       todayFiredFlag: null,         cooldownMs: 3600000,  recentAvoidN: 2 },
  { id: "work_break",      todayFiredFlag: null,         cooldownMs: 7200000,  recentAvoidN: 1 },
  { id: "back_from_away",  todayFiredFlag: null,         cooldownMs: 1800000,  recentAvoidN: 2 },
  { id: "rainy_day",       todayFiredFlag: "weather",    cooldownMs: 14400000, recentAvoidN: 2 },
  { id: "cold_drop",       todayFiredFlag: "weather",    cooldownMs: 14400000, recentAvoidN: 2 },
  { id: "sunny_day",       todayFiredFlag: "weather",    cooldownMs: 14400000, recentAvoidN: 2 },
];

/** 三檔 Desire 增速（每分鐘）。off 不啟動 tick。 */
export const DESIRE_RATE: Record<"quiet" | "normal" | "lively", number> = {
  quiet: 1,
  normal: 2,
  lively: 4,
};

export const DESIRE_THRESHOLD = 40;        // 起步閾值
export const RESPONSE_WINDOW_MS = 300000;  // 5 分鐘響應窗口

/** affinity 邊界。 */
export const AFFINITY_MIN = 0.3;
export const AFFINITY_MAX = 2.0;
export const AFFINITY_ON_CLICK = 1.2;
export const AFFINITY_ON_IGNORE = 0.85;

/** desireRateMultiplier 邊界。 */
export const RATE_MULT_MIN = 0.5;
export const RATE_MULT_MAX = 1.5;
export const RATE_MULT_ON_CLICK = 1.05;
export const RATE_MULT_ON_IGNORE = 0.95;
