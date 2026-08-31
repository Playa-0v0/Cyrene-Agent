// Music 面板内部状态
// 从 settings.ts 顶层 let 抽离，收进单一对象。
// 所有 music 函数通过 musicState.xxx 读写，行为与原顶层 let 等价。

export const musicState = {
  panelInitialized: false as boolean,
  stateUnsub: null as (() => void) | null,
  loginPollTimer: null as number | null,
  lastQrDataUrl: null as string | null,
  initPollTimer: null as number | null,
};
