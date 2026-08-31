// TTS 面板内部状态
// 从 settings.ts 顶层 let 抽离，收进单一对象。

export const ttsState = {
  config: {} as Record<string, unknown>,
};
