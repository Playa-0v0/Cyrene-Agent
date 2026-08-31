// Plugins 面板内部状态（天气/出行/邮件插件 debounce timers）
// 从 settings.ts 顶层 let 抽离，收进单一对象。

export const pluginsState = {
  amapKeyDebounceTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  travelAmapKeyDebounceTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  emailSmtpHostTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  emailSmtpPortTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  emailSmtpUserTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  emailSmtpPassTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  emailFromNameTimer: undefined as ReturnType<typeof setTimeout> | undefined,
};
