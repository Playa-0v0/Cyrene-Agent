// ASR 面板内部状态
// 从 settings.ts 顶层 let 抽离，收进单一对象。

export const asrState = {
  aliyunAppKeyTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  aliyunAccessKeyIdTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  aliyunAccessKeySecretTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  mosslandKeyTimer: undefined as ReturnType<typeof setTimeout> | undefined,
};
