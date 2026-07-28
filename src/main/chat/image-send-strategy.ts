export type ImageSendStrategy = { mode: "direct" } | { mode: "caption" };

export interface ImageSendStrategyConfig {
  /** 主模型是否多模态。true 时图片直发主模型（direct），用户手动控制。 */
  multimodal: boolean;
  vision?: {
    baseUrl: string;
    model: string;
    apiKey: string;
  } | null;
}

/**
 * 裁决图片发送策略。用户的多模态开关是唯一裁决者：
 * - multimodal=true  -> direct（图片随 message 直发主模型）
 * - multimodal=false -> caption（走独立视觉模型分析，或无法看图）
 */
export function decideImageSendStrategy(config: ImageSendStrategyConfig): ImageSendStrategy {
  if (config.multimodal) return { mode: "direct" };
  return { mode: "caption" };
}
