// Preferences 面板内部状态
// 从 settings.ts 顶层 let 抽离，收进单一对象。

import type { CustomStyleConfig } from "../../../shared/style-sampling";
import { DEFAULT_CUSTOM_STYLE } from "../../../shared/style-sampling";

export const preferencesState = {
  currentCustomStyleConfig: DEFAULT_CUSTOM_STYLE as CustomStyleConfig,
  customStyleOverlay: null as HTMLElement | null,
  stickerAddPickedPath: null as string | null,
};
