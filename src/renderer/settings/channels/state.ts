// Channels 面板内部状态
// 从 settings.ts 顶层 let 抽离，收进单一对象。

export const channelsState = {
  initialized: false as boolean,
  saveTimer: null as number | null,
};
