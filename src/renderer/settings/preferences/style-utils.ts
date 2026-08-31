// Preferences 面板纯函数：CustomStyleConfig 多样性读取
// 从 settings.ts 抽离，无 DOM/状态依赖。

import type { CustomStyleConfig, DiversityPreference } from "../../../shared/style-sampling";

/** 读取自定义风格配置的 diversity driver（始终返回当前 driver，含 model-default）。 */
export function diversityDriverOf(config: CustomStyleConfig): DiversityPreference["driver"] {
  return config.diversity.driver;
}

/** 读取 temperature/top-p 驱动的多样性值；其它 driver 返回 0.65 默认。 */
export function diversityValueOf(config: CustomStyleConfig): number {
  return config.diversity.driver === "temperature" || config.diversity.driver === "top-p"
    ? config.diversity.value
    : 0.65;
}
